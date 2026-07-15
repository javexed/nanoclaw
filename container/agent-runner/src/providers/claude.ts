import fs from 'fs';
import os from 'os';
import path from 'path';

import { query as sdkQuery, type HookCallback, type PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';

import { appendStatusEvent, clearContainerToolInFlight, setContainerToolInFlight } from '../db/connection.js';
import { TIMEZONE, formatLocalStamp } from '../timezone.js';
import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';

function log(msg: string): void {
  console.error(`[claude-provider] ${msg}`);
}

// Deferred SDK builtins that either sidestep nanoclaw's own scheduling or
// don't fit our async message-passing model (they're designed for Claude
// Code's interactive UI and would hang here).
//
// - CronCreate / CronDelete / CronList / ScheduleWakeup: we have durable
//   scheduling via `ncl tasks`.
// - AskUserQuestion: SDK returns a placeholder instead of blocking on a
//   real answer — we have mcp__nanoclaw__ask_user_question that persists
//   the question and blocks on the real reply.
// - EnterPlanMode / ExitPlanMode / EnterWorktree / ExitWorktree: Claude
//   Code UI affordances; in a headless container they'd appear stuck.
// - DesignSync: desktop design-tool integration — nothing to sync with in a
//   headless container (~9.3KB/turn schema).
// - ReportFindings: code-review-reporting UI affordance with no headless
//   host surface to receive it (~1.9KB/turn schema).
const SDK_DISALLOWED_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
  'DesignSync',
  'ReportFindings',
];

// Tool allowlist for NanoClaw agent containers. MCP-tool entries are derived
// at the call site from the registered `mcpServers` map so that any server
// added via `add_mcp_server` (or wired in container.json directly) is
// reachable to the agent — without this, the SDK's allowedTools filter
// silently drops every MCP namespace not listed here.
const TOOL_ALLOWLIST = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
];

// MCP server names are sanitized by the SDK when forming tool prefixes:
// any character outside [A-Za-z0-9_-] becomes '_'. Mirror that here so our
// allowlist patterns match what the SDK actually exposes.
function mcpAllowPattern(serverName: string): string {
  return `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}__*`;
}

// Tool-level allowlisting: a server with `enabledTools` gets ONLY those tools
// listed; everything else the server exposes is filtered out by the SDK and
// never even enters the agent's context. No allowlist → the whole namespace.
function mcpAllowEntries(serverName: string, cfg: import('./types.js').McpServerConfig): string[] {
  const enabled = cfg.enabledTools;
  if (!Array.isArray(enabled) || enabled.length === 0) return [mcpAllowPattern(serverName)];
  const ns = serverName.replace(/[^a-zA-Z0-9_-]/g, '_');
  return enabled.map((t) => `mcp__${ns}__${String(t).replace(/[^a-zA-Z0-9_-]/g, '_')}`);
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Push-based async iterable for streaming user messages to the Claude SDK.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

// ── Transcript archiving (PreCompact hook) ──

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      /* skip unparseable lines */
    }
  }
  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const dateStr = now.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const lines = [`# ${title || 'Conversation'}`, '', `Archived: ${dateStr}`, '', '---', ''];
  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
    lines.push(`**${sender}**: ${content}`, '');
  }
  return lines.join('\n');
}

/**
 * Pull a short, human-meaningful target out of a tool's input for the webchat
 * status feed — the file a Read/Edit touches, the command Bash runs, the query
 * a search uses. Returns null when the tool has no salient target (the client
 * then shows just the tool verb). Host-side redaction scrubs secrets before any
 * of this reaches a client.
 */
function summarizeToolTarget(toolName: string, input: Record<string, unknown> | undefined): string | null {
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  switch (toolName) {
    case 'Bash':
      return str(input?.command);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return str(input?.file_path) ?? str(input?.notebook_path);
    case 'Glob':
    case 'Grep':
      return str(input?.pattern);
    case 'WebFetch':
      return str(input?.url);
    case 'WebSearch':
      return str(input?.query);
    default:
      return null;
  }
}

/** Max reasoning lines surfaced per thinking block, and per-line char cap. The
 *  webchat feed only keeps the last few anyway; this just bounds WS/DB volume
 *  for a long thinking trace. */
const REASONING_MAX_LINES = 8;
const REASONING_LINE_MAX = 200;

/**
 * Turn a raw thinking block into a short list of feed lines: split on
 * newlines, strip markdown header/bullet noise, drop empties, truncate each,
 * and cap the count (keeping the LAST lines — the conclusion of the reasoning
 * is the most informative).
 */
export function summarizeThinking(thinking: string): string[] {
  const lines = thinking
    .split(/\n+/)
    .map((l) => l.replace(/^[#>\-*\s]+/, '').trim())
    .filter((l) => l.length > 0)
    .map((l) => (l.length > REASONING_LINE_MAX ? `${l.slice(0, REASONING_LINE_MAX - 1)}…` : l));
  return lines.slice(-REASONING_MAX_LINES);
}

/**
 * PreToolUse hook: record the current tool + its declared timeout so the host
 * sweep can widen its stuck tolerance while Bash is running a long-declared
 * script. Defense-in-depth: if SDK_DISALLOWED_TOOLS slips through somehow,
 * block the call here instead of letting the agent hang.
 */
/**
 * Last-invoked telemetry for the learning loop's curator (design §6). When the
 * SDK loads a skill, stamp `.last-invoked` in that skill's dir so the host-side
 * curator can age scoped skills by USE rather than by creation date.
 *
 * Field-name-agnostic on purpose: the Skill tool's input isn't in the SDK's
 * typed schemas, so instead of guessing a field we stamp whichever input string
 * exactly names a real skill dir — it cannot stamp the wrong thing. Pooled
 * skills are symlinks into a read-only mount; the write fails and is skipped,
 * which is correct: the curator only manages scoped skills anyway.
 */
const SKILLS_DIR = process.env.CLAUDE_SKILLS_DIR || '/home/node/.claude/skills';
function stampSkillInvocation(toolInput: Record<string, unknown> | undefined): void {
  if (!toolInput) return;
  for (const v of Object.values(toolInput)) {
    if (typeof v !== 'string' || !v || v.includes('/') || v.includes('..')) continue;
    const dir = path.join(SKILLS_DIR, v);
    try {
      if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
      fs.writeFileSync(path.join(dir, '.last-invoked'), new Date().toISOString());
      // Effectiveness telemetry: a monotone use counter next to the recency
      // stamp. Same best-effort contract — pooled read-only skills skip both.
      let n = 0;
      try {
        n = parseInt(fs.readFileSync(path.join(dir, '.invocations'), 'utf8'), 10) || 0;
      } catch {
        /* first invocation */
      }
      fs.writeFileSync(path.join(dir, '.invocations'), String(n + 1));
    } catch {
      /* read-only pooled skill, or a race — either way not ours to stamp */
    }
  }
}

const preToolUseHook: HookCallback = async (input) => {
  const i = input as { tool_name?: string; tool_input?: Record<string, unknown> };
  const toolName = i.tool_name ?? '';
  if (SDK_DISALLOWED_TOOLS.includes(toolName)) {
    return {
      decision: 'block',
      stopReason: `Tool '${toolName}' is not available in this environment — use the nanoclaw equivalent.`,
    } as unknown as ReturnType<HookCallback>;
  }
  // Bash exposes its timeout via the tool_input.timeout field (ms). Any other
  // tool: no declared timeout.
  const declaredTimeoutMs =
    toolName === 'Bash' && typeof i.tool_input?.timeout === 'number' ? (i.tool_input.timeout as number) : null;
  try {
    setContainerToolInFlight(toolName, declaredTimeoutMs);
  } catch (err) {
    log(`PreToolUse: failed to record container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Cosmetic activity feed for the webchat thinking bubble (best-effort).
  if (toolName) appendStatusEvent('tool', toolName, summarizeToolTarget(toolName, i.tool_input));
  if (toolName === 'Skill') stampSkillInvocation(i.tool_input);
  return { continue: true };
};

/** Clear in-flight tool on PostToolUse / PostToolUseFailure. */
const postToolUseHook: HookCallback = async () => {
  try {
    clearContainerToolInFlight();
  } catch (err) {
    log(`PostToolUse: failed to clear container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

/**
 * Read a Claude transcript .jsonl, render a markdown summary, and drop it into
 * the agent's `conversations/` folder so context survives a compaction or a
 * session rotation. Best-effort: returns false (and logs) on any failure.
 */
function archiveTranscriptFile(
  transcriptPath: string | undefined,
  sessionId: string | undefined,
  assistantName?: string,
): boolean {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    log('No transcript found for archiving');
    return false;
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const messages = parseTranscript(content);
    if (messages.length === 0) return false;

    // Try to get summary from sessions index
    let summary: string | undefined;
    const indexPath = path.join(path.dirname(transcriptPath), 'sessions-index.json');
    if (fs.existsSync(indexPath)) {
      try {
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        summary = index.entries?.find(
          (e: { sessionId: string; summary?: string }) => e.sessionId === sessionId,
        )?.summary;
      } catch {
        /* ignore */
      }
    }

    const name = summary
      ? summary
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 50)
      : `conversation-${new Date().getHours().toString().padStart(2, '0')}${new Date().getMinutes().toString().padStart(2, '0')}`;

    const conversationsDir = process.env.NANOCLAW_CONVERSATIONS_DIR || '/workspace/agent/conversations';
    fs.mkdirSync(conversationsDir, { recursive: true });
    // Local calendar date — the fallback `name` above already uses local
    // hours, and the agent navigates conversations/ by these date prefixes.
    const filename = `${formatLocalStamp(new Date(), TIMEZONE).slice(0, 10)}-${name}.md`;
    fs.writeFileSync(path.join(conversationsDir, filename), formatTranscriptMarkdown(messages, summary, assistantName));
    log(`Archived conversation to ${filename}`);
    return true;
  } catch (err) {
    log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    archiveTranscriptFile(preCompact.transcript_path, preCompact.session_id, assistantName);
    return {};
  };
}

// ── Continuation rotation (cold-resume guard) ──

/**
 * Resume cost is dominated by transcript size. Past this many bytes a fresh
 * cold container can't reload the .jsonl before the host's 30-min idle ceiling
 * fires, so the session is dropped and started clean. Operator-overridable.
 */
function transcriptRotateBytes(): number {
  return Number(process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES) || 12 * 1024 * 1024;
}

/**
 * Secondary age trigger, measured from the transcript's first entry. 0 (or a
 * non-positive value) disables the age check; size alone then governs.
 */
function transcriptRotateAgeMs(): number {
  const raw = process.env.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS;
  if (raw === undefined || raw.trim() === '') return 14 * 86_400_000;
  const days = Number(raw);
  if (!Number.isFinite(days)) return 14 * 86_400_000;
  // Explicit non-positive override disables the age check; size alone governs.
  return days > 0 ? days * 86_400_000 : Infinity;
}

function claudeProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.claude');
  return path.join(base, 'projects');
}

/**
 * Locate the .jsonl backing a session id. The SDK names project dirs by a
 * mangled cwd; rather than reproduce that convention we scan project dirs for
 * `<sessionId>.jsonl` (session ids are UUIDs, so this is unambiguous).
 */
function findTranscriptPath(sessionId: string): string | null {
  const projects = claudeProjectsDir();
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(projects, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Epoch-ms of the first transcript entry, or null if unreadable. */
function transcriptStartMs(transcriptPath: string): number | null {
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const firstLine = buf.toString('utf-8', 0, n).split('\n', 1)[0];
      const ts = JSON.parse(firstLine)?.timestamp;
      const ms = ts ? Date.parse(ts) : NaN;
      return Number.isNaN(ms) ? null : ms;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

// ── Provider ──

/**
 * Claude Code auto-compacts context at this window (tokens). Kept here so
 * the generic bootstrap doesn't need to know about Claude-specific env vars.
 *
 * Operator override: set CLAUDE_CODE_AUTO_COMPACT_WINDOW in the host env to
 * raise or lower the threshold without editing source — useful when running
 * with a 1M-context model variant or when emergency-tuning a deployment.
 */
const CLAUDE_CODE_AUTO_COMPACT_WINDOW = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '165000';

/**
 * Stale-session detection. Matches Claude Code's error text when a
 * resumed session can't be found — missing transcript .jsonl, unknown
 * session ID, etc.
 */
const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

/**
 * Classify a terminal error's text so the poll-loop can react precisely:
 *
 *  - `'config'` — the model itself is unusable: not found, invalid, rejected,
 *    or an auth failure that means the configured model/backend is wrong
 *    (model-not-found, invalid-model, 401/404, unauthorized). These are the
 *    cases worth retrying against the SDK default model.
 *  - `'network'` — the backend was unreachable (connection refused, fetch
 *    failed, timed out). Retrying the same broken endpoint won't help.
 *  - `undefined` — unclassified; surfaced verbatim, no special handling.
 *
 * Patterns are intentionally broad/lowercased — SDK and Ollama error text
 * varies, and a false `config` only costs one extra (cheap) default-model try.
 */
export interface SdkRateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  errorCode?: string;
  overageDisabledReason?: string;
}

/**
 * Map an SDK `rate_limit_event` to a provider event — or to NOTHING.
 *
 * The SDK emits this "when rate limit info changes": it is TELEMETRY, and
 * `status` is usually 'allowed' (here's your remaining headroom). We used to
 * treat every one as a terminal error, which aborted perfectly healthy turns
 * across every room — the agent stopped mid-work and posted a rate-limit notice
 * for what was only a status update. **Only 'rejected' is an actual block.**
 *
 * When it IS rejected the SDK tells us WHY, so we distinguish properly instead
 * of guessing: `errorCode: 'credits_required'` / `overageDisabledReason:
 * 'out_of_credits'` means genuinely out of credits (billing); anything else is a
 * transient window limit that resets (`resetsAt`, `rateLimitType`).
 *
 * Returns null when the event is informational (do not disturb the turn).
 */
export function classifyRateLimitEvent(
  info: SdkRateLimitInfo | undefined,
): { message: string; classification: 'rate_limit' | 'quota' } | null {
  if (info?.status !== 'rejected') return null;
  const outOfCredits = info.errorCode === 'credits_required' || info.overageDisabledReason === 'out_of_credits';
  let detail = '';
  if (typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt)) {
    const ms = info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt;
    detail = ` (resets ${new Date(ms).toISOString()})`;
  }
  const window = info.rateLimitType ? ` [${info.rateLimitType}]` : '';
  return {
    message: `${outOfCredits ? 'Out of credits' : 'Rate limit'}${window}${detail}`,
    classification: outOfCredits ? 'quota' : 'rate_limit',
  };
}

export function classifyTerminalError(text: string): 'config' | 'network' | undefined {
  const t = text.toLowerCase();

  // Network first: an ECONNREFUSED to a custom base URL can also mention the
  // model, but the actionable fault is the unreachable endpoint.
  if (
    t.includes('econnrefused') ||
    t.includes('connection refused') ||
    t.includes('fetch failed') ||
    t.includes('etimedout') ||
    t.includes('timed out')
  ) {
    return 'network';
  }

  if (
    t.includes('model not found') ||
    (t.includes('not found') && t.includes('model')) ||
    t.includes('invalid model') ||
    t.includes('invalid_model') ||
    t.includes('unknown model') ||
    t.includes('unauthorized') ||
    t.includes('401') ||
    t.includes('404') ||
    (t.includes('model') && (t.includes('reject') || t.includes('does not exist') || t.includes('not supported')))
  ) {
    return 'config';
  }

  return undefined;
}

export class ClaudeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = true;
  // Both halves are real here: allowedTools drops to draft_skill alone, and the
  // SDK's forkSession keeps the review off the main session's transcript.
  readonly supportsRestrictedReview = true;

  private assistantName?: string;
  private mcpServers: Record<string, McpServerConfig>;
  private env: Record<string, string | undefined>;
  private settingSources: Array<'project' | 'user' | 'local'>;
  private additionalDirectories?: string[];
  private model?: string;
  private effort?: string;

  constructor(options: ProviderOptions = {}) {
    this.assistantName = options.assistantName;
    this.mcpServers = options.mcpServers ?? {};
    this.additionalDirectories = options.additionalDirectories;
    this.model = options.model;
    this.effort = options.effort;
    this.env = {
      ...(options.env ?? {}),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    };
    this.settingSources = options.settingSources ?? ['project', 'user', 'local'];
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  maybeRotateContinuation(continuation: string): string | null {
    const transcriptPath = findTranscriptPath(continuation);
    if (!transcriptPath) return null;

    let size: number;
    try {
      size = fs.statSync(transcriptPath).size;
    } catch {
      return null;
    }

    const maxBytes = transcriptRotateBytes();
    const startMs = transcriptStartMs(transcriptPath);
    const ageMs = startMs === null ? 0 : Date.now() - startMs;
    const maxAgeMs = transcriptRotateAgeMs();

    let reason: string | null = null;
    if (size > maxBytes) {
      reason = `transcript ${(size / 1_048_576).toFixed(1)}MB > ${(maxBytes / 1_048_576).toFixed(0)}MB cap`;
    } else if (startMs !== null && ageMs > maxAgeMs) {
      reason = `transcript ${(ageMs / 86_400_000).toFixed(1)}d old > ${(maxAgeMs / 86_400_000).toFixed(0)}d cap`;
    }
    if (!reason) return null;

    // Preserve a readable summary, then move the heavy .jsonl out of the
    // resume path so the SDK starts a fresh session and the disk is reclaimed.
    archiveTranscriptFile(transcriptPath, continuation, this.assistantName);
    try {
      fs.renameSync(transcriptPath, `${transcriptPath}.rotated-${Date.now()}`);
    } catch (err) {
      log(`Failed to move rotated transcript aside: ${err instanceof Error ? err.message : String(err)}`);
    }
    return reason;
  }

  query(input: QueryInput): AgentQuery {
    const stream = new MessageStream();
    stream.push(input.prompt);

    const instructions = input.systemContext?.instructions;

    // A learning review runs on a FORK of the session (transcript in context,
    // main conversation untouched) with draft_skill as its only tool. A cheaper
    // model may serve it via NANOCLAW_LEARNING_MODEL — authoring a SKILL.md from
    // a transcript needs less model than producing the transcript did.
    const review = input.learningReview === true;
    const sdkResult = sdkQuery({
      prompt: stream,
      options: {
        cwd: input.cwd,
        additionalDirectories: this.additionalDirectories,
        resume: input.continuation,
        forkSession: review ? true : undefined,
        pathToClaudeCodeExecutable: '/pnpm/claude',
        systemPrompt: instructions
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: instructions }
          : undefined,
        allowedTools: review
          ? ['mcp__nanoclaw__draft_skill']
          : [...TOOL_ALLOWLIST, ...Object.entries(this.mcpServers).flatMap(([name, cfg]) => mcpAllowEntries(name, cfg))],
        disallowedTools: SDK_DISALLOWED_TOOLS,
        env: this.env,
        model: review ? process.env.NANOCLAW_LEARNING_MODEL || this.model : this.model,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        effort: this.effort as any,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: this.settingSources,
        mcpServers: this.mcpServers,
        hooks: {
          PreToolUse: [{ hooks: [preToolUseHook] }],
          PostToolUse: [{ hooks: [postToolUseHook] }],
          PostToolUseFailure: [{ hooks: [postToolUseHook] }],
          PreCompact: [{ hooks: [createPreCompactHook(this.assistantName)] }],
        },
      },
    });

    let aborted = false;

    async function* translateEvents(): AsyncGenerator<ProviderEvent> {
      let messageCount = 0;
      try {
        for await (const message of sdkResult) {
          if (aborted) return;
          messageCount++;

          // Yield activity for every SDK event so the poll loop knows the agent is working
          yield { type: 'activity' };

          if (message.type === 'system' && message.subtype === 'init') {
            yield { type: 'init', continuation: message.session_id };
          } else if (message.type === 'result') {
            // `result` text exists only on subtype:"success"; error subtypes
            // (e.g. a non-retryable 403 billing_error) carry their message in
            // `errors[]` instead. Surface either so the poll-loop can deliver a
            // billing/quota notice to the user rather than dropping the turn.
            const m = message as { result?: string; is_error?: boolean; errors?: string[] };
            const text = m.result ?? (m.errors && m.errors.length > 0 ? m.errors.join('\n') : null);
            yield { type: 'result', text, isError: m.is_error === true };
          } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'api_retry') {
            yield { type: 'error', message: 'API retry', retryable: true };
          } else if (message.type === 'rate_limit_event') {
            // The SDK emits this "when rate limit info CHANGES" — it is telemetry,
            // not necessarily an error. `rate_limit_info.status` is usually
            // 'allowed' (here's your remaining headroom). Treating every one of
            // these as a terminal error aborted perfectly healthy turns across
            // every room — the agent would stop mid-work and post a rate-limit
            // notice for what was just a status update. ONLY 'rejected' is an
            // actual block.
            //
            // When it IS rejected the SDK tells us WHY, so we can finally
            // distinguish the two cases properly instead of guessing:
            //   errorCode 'credits_required' / overageDisabledReason
            //   'out_of_credits'  → genuinely out of credits (billing)
            //   otherwise         → a transient window limit that resets.
            const info = (message as { rate_limit_info?: SdkRateLimitInfo }).rate_limit_info;
            const blocked = classifyRateLimitEvent(info);
            if (!blocked) {
              // Informational ('allowed' / 'allowed_warning') — never kill the turn.
              if (info?.status === 'allowed_warning') {
                log(
                  `rate-limit warning: ${info.rateLimitType ?? 'window'} at ${
                    info.utilization != null ? `${Math.round(info.utilization * 100)}%` : 'high'
                  } utilization`,
                );
              }
            } else {
              yield { type: 'error', message: blocked.message, retryable: false, classification: blocked.classification };
            }
          } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
            const meta = (message as { compact_metadata?: { pre_tokens?: number } }).compact_metadata;
            const detail = meta?.pre_tokens ? ` (${meta.pre_tokens.toLocaleString()} tokens compacted)` : '';
            yield { type: 'result', text: `Context compacted${detail}.` };
          } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
            const tn = message as { summary?: string };
            yield { type: 'progress', message: tn.summary || 'Task notification' };
          } else if (message.type === 'assistant') {
            // Surface the agent's reasoning (extended-thinking blocks) to rich
            // clients as a fading feed. Cosmetic; absent when the model emits no
            // thinking. Text blocks are handled separately as the final result.
            const content = (message as { message?: { content?: unknown } }).message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block && (block as { type?: string }).type === 'thinking') {
                  const thinking = (block as { thinking?: string }).thinking;
                  if (typeof thinking === 'string' && thinking.length > 0) {
                    for (const line of summarizeThinking(thinking)) {
                      yield { type: 'reasoning', message: line };
                    }
                  }
                }
              }
            }
          }
        }
      } catch (err) {
        // A THROWN SDK failure — model not found, backend unreachable, the
        // subprocess dying mid-stream — would otherwise escape the generator
        // and surface as an opaque rejection (or, on the follow-up path,
        // silence). Re-emit it as a non-retryable terminal error so the
        // poll-loop can surface it / fall back, then end the stream.
        if (aborted) return;
        const detail = err instanceof Error ? err.message : String(err);
        log(`SDK stream threw: ${detail}`);
        yield {
          type: 'error',
          message: detail,
          retryable: false,
          classification: classifyTerminalError(detail),
        };
        return;
      }
      log(`Query completed after ${messageCount} SDK messages`);
    }

    return {
      push: (msg) => stream.push(msg),
      end: () => stream.end(),
      events: translateEvents(),
      abort: () => {
        aborted = true;
        stream.end();
      },
    };
  }
}

registerProvider('claude', (opts) => new ClaudeProvider(opts));
