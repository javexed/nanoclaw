import { spawn, type ChildProcess } from 'child_process';

import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';

import { registerProvider } from './provider-registry.js';
import { notifyProviderMessage } from './hooks.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import type { MemorySessionHookRegistration } from '../memory/session-hook.js';
import { mcpServersToOpenCodeConfig } from './mcp-to-opencode.js';

// Reasoning streams incrementally (each update carries the full accumulated text),
// so we surface only the growth — and only once a natural boundary or a chunk of
// this size has accrued, so token-by-token updates don't spam the feed.
const REASONING_MIN_CHUNK = 80;
const REASONING_LINE_MAX = 200;

/**
 * Split a streamed reasoning delta into feed-sized lines: break on sentence and
 * line boundaries, trim, drop trivial fragments, and cap each line's length.
 * Purely cosmetic — drives the thinking bubble's activity feed.
 */
function reasoningChunks(delta: string): string[] {
  return delta
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3)
    .map((s) => (s.length > REASONING_LINE_MAX ? `${s.slice(0, REASONING_LINE_MAX - 1)}…` : s));
}

// Some thinking models (notably qwen3 via Ollama) sometimes emit only a reasoning
// block and then stop, with no final text answer — so the turn comes back empty
// and the user gets nothing. We can't know a-priori which models do this (it's
// per-model AND per-prompt), so we detect it at runtime (reasoning present +
// empty result), retry that turn once with thinking disabled, and REMEMBER the
// model so later turns skip straight to thinking-off (no wasted first inference,
// no hand-maintained "reliable models" list). Learning is per agent-runner process.
const THINKING_OFF_DIRECTIVE = '/no_think'; // qwen3-family soft-switch; inert for others
const MAX_STALL_RETRIES = 2; // thinking-off isn't a guarantee (small models are flaky), so retry a few times
const thinkingOffModels = new Set<string>();
function withThinkingOff(text: string): string {
  return text.includes(THINKING_OFF_DIRECTIVE) ? text : `${text}\n${THINKING_OFF_DIRECTIVE}`;
}

function log(msg: string): void {
  console.error(`[opencode-provider] ${msg}`);
}

const SESSION_STATUS_RETRY_ERROR_AFTER = 3;

/** Stale / dead OpenCode session heuristics (complement Claude-centric host patterns). */
const STALE_SESSION_RE =
  /no conversation found|ENOENT.*\.jsonl|session.*not found|NotFoundError|connection reset|ECONNRESET|404|event timeout/i;

function killProcessTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

function spawnOpencodeServer(
  config: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<{ url: string; proc: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const hostname = '127.0.0.1';
    const port = 4096;
    const proc = spawn('opencode', ['serve', `--hostname=${hostname}`, `--port=${port}`], {
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
      detached: true,
    });

    const id = setTimeout(() => {
      killProcessTree(proc);
      reject(new Error(`Timeout waiting for OpenCode server to start after ${timeoutMs}ms`));
    }, timeoutMs);

    let output = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        if (line.startsWith('opencode server listening')) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (match) {
            clearTimeout(id);
            resolve({ url: match[1], proc });
          }
        }
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.on('exit', (code) => {
      clearTimeout(id);
      let msg = `OpenCode server exited with code ${code}`;
      if (output.trim()) msg += `\nServer output: ${output}`;
      reject(new Error(msg));
    });
    proc.on('error', (err) => {
      clearTimeout(id);
      reject(err);
    });
  });
}

function wrapPromptWithContext(text: string, systemInstructions?: string): string {
  let out = text;
  if (systemInstructions) {
    out = `<system>\n${systemInstructions}\n</system>\n\n${out}`;
  }
  return out;
}

function buildOpenCodeConfig(options: ProviderOptions): Record<string, unknown> {
  const provider = process.env.OPENCODE_PROVIDER || 'anthropic';
  const model = process.env.OPENCODE_MODEL;
  const smallModel = process.env.OPENCODE_SMALL_MODEL;
  const proxyUrl = process.env.ANTHROPIC_BASE_URL;

  const providerModelId = model ? model.replace(new RegExp(`^${provider}/`), '') : undefined;
  const providerSmallModelId = smallModel ? smallModel.replace(new RegExp(`^${provider}/`), '') : undefined;
  const modelsToRegister = [providerModelId, providerSmallModelId]
    .filter(Boolean)
    .filter((mid, i, a) => a.indexOf(mid as string) === i);

  const providerOptions: Record<string, unknown> =
    provider === 'anthropic'
      ? {}
      : {
          [provider]: {
            options: { apiKey: 'placeholder', baseURL: proxyUrl },
            ...(modelsToRegister.length > 0
              ? {
                  models: Object.fromEntries(
                    modelsToRegister.map((mid) => [mid, { id: mid, name: mid, tool_call: true }]),
                  ),
                }
              : {}),
          },
        };

  const mcp = mcpServersToOpenCodeConfig(options.mcpServers);

  // Load shared base + per-group fragments + per-group memory through OpenCode's
  // native instructions pipeline (session/instruction.ts). Absolute paths with
  // globs are supported. Files are read raw — `@./...` includes are NOT expanded
  // by OpenCode, so point at the concrete files, not at composed CLAUDE.md.
  const instructions = [
    '/app/CLAUDE.md',
    '/workspace/agent/.claude-fragments/*.md',
    '/workspace/agent/CLAUDE.local.md',
  ];

  const config: Record<string, unknown> = {
    ...(model ? { model } : {}),
    ...(smallModel ? { small_model: smallModel } : {}),
    enabled_providers: [provider],
    permission: 'allow',
    autoupdate: false,
    snapshot: false,
    provider: providerOptions,
    instructions,
    mcp,
  };

  // Lean prompt for weak local models. OpenCode's default is the "build" coding
  // agent, whose system prompt is ~16k tokens (file-edit protocols, tool-use
  // scaffolding) — far too heavy for an 8B, and it blows past a local model's
  // usable context, so most of it (including our own message-format rules) gets
  // truncated. Replace the primary agents' prompt with a minimal chat prompt and
  // strip the code tools. The message-format + destination rules still reach the
  // model via the wrapped systemContext (~2k), so nothing functional is lost.
  // nanoclaw-web runs OpenCode exclusively as the local-Ollama harness (the
  // host's provider sync only flips a group here for ollama-kind models), so
  // the lean prompt is derived from the model itself rather than threaded
  // through ProviderOptions: every ollama/* model gets it.
  const lenientPrompt = (process.env.OPENCODE_MODEL || '').startsWith('ollama/');
  if (lenientPrompt) {
    const leanPrompt =
      'You are a helpful assistant in a chat conversation. Read the conversation and reply directly and concisely to the most recent message. Follow any formatting or destination instructions given in the system context. Do not narrate your steps or use tools unless explicitly asked.';
    // Disable every built-in tool — a lean chat agent replies via the <message to>
    // text envelope and needs none of them; their schemas are most of the bulk.
    const noCodeTools = {
      invalid: false,
      question: false,
      bash: false,
      read: false,
      glob: false,
      grep: false,
      edit: false,
      write: false,
      task: false,
      webfetch: false,
      todowrite: false,
      websearch: false,
      codesearch: false,
      skill: false,
      apply_patch: false,
    };
    const lean = { prompt: leanPrompt, tools: noCodeTools };
    config.agent = { build: lean, general: lean, plan: lean };
  }

  return config;
}

type SharedRuntime = {
  proc: ChildProcess;
  client: OpencodeClient;
  stream: AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
  streamRelease: () => void;
};

let sharedRuntime: SharedRuntime | null = null;
let sharedConfigKey: string | null = null;
let sharedInit: Promise<SharedRuntime> | null = null;

function runtimeConfigKey(options: ProviderOptions): string {
  return JSON.stringify({
    mcp: mcpServersToOpenCodeConfig(options.mcpServers),
    model: process.env.OPENCODE_MODEL,
    small: process.env.OPENCODE_SMALL_MODEL,
    op: process.env.OPENCODE_PROVIDER,
  });
}

async function ensureSharedRuntime(options: ProviderOptions): Promise<SharedRuntime> {
  const key = runtimeConfigKey(options);
  if (sharedRuntime && sharedConfigKey === key) return sharedRuntime;

  if (sharedInit) return sharedInit;

  sharedInit = (async () => {
    if (sharedRuntime) {
      destroySharedRuntime();
    }
    const config = buildOpenCodeConfig(options);
    const { url, proc } = await spawnOpencodeServer(config);
    const client = createOpencodeClient({ baseUrl: url });
    const sub = await client.event.subscribe();
    const stream = sub.stream as AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
    sharedRuntime = {
      proc,
      client,
      stream,
      streamRelease: () => {
        void stream.return?.(undefined);
      },
    };
    sharedConfigKey = key;
    sharedInit = null;
    return sharedRuntime;
  })();

  return sharedInit;
}

export function destroySharedRuntime(): void {
  if (sharedRuntime) {
    try {
      sharedRuntime.streamRelease();
    } catch {
      /* ignore */
    }
    killProcessTree(sharedRuntime.proc);
    sharedRuntime = null;
    sharedConfigKey = null;
  }
  sharedInit = null;
}

function sessionErrorMessage(props: { error?: unknown }): string {
  const err = props.error as { data?: { message?: string } } | undefined;
  if (err && typeof err === 'object' && err.data && typeof err.data.message === 'string') {
    return err.data.message;
  }
  return JSON.stringify(props.error) || 'OpenCode session error';
}

export class OpenCodeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly options: ProviderOptions;
  private activeSessionId: string | undefined;

  constructor(options: ProviderOptions = {}) {
    this.options = options;
  }

  // OpenCode injects shared memory through its native `instructions` pipeline
  // (see buildOpenCodeConfig — it points at CLAUDE.md + .claude-fragments), not
  // a session-start hook the way Claude does. Nothing to register here.
  registerMemorySessionHook(_hook: MemorySessionHookRegistration): void {}

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    if (input.continuation) {
      this.activeSessionId = input.continuation;
    } else {
      this.activeSessionId = undefined;
    }

    const pending: Array<{ text: string; retries: number }> = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;

    const systemInstructions = input.systemContext?.instructions;
    pending.push({ text: wrapPromptWithContext(input.prompt, systemInstructions), retries: 0 });

    const kick = (): void => {
      waiting?.();
    };

    const self = this;
    const IDLE_TIMEOUT_MS = Number(process.env.OPENCODE_IDLE_TIMEOUT_MS) || 300_000;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      let initYielded = false;
      const rt = await ensureSharedRuntime(self.options);
      const { client, stream } = rt;

      while (!aborted) {
        while (pending.length === 0 && !ended && !aborted) {
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }

        if (aborted) return;
        if (pending.length === 0 && ended) return;

        const modelKey = process.env.OPENCODE_MODEL || '';
        // If this model has stalled on thinking before, skip straight to thinking-off.
        const item = pending.shift()!;
        let text = item.text;
        if (thinkingOffModels.has(modelKey)) text = withThinkingOff(text);
        const thinkingOffThisTurn = text.includes(THINKING_OFF_DIRECTIVE);
        let sessionId = self.activeSessionId;

        if (!sessionId) {
          const created = await client.session.create();
          if (created.error) {
            throw new Error(`OpenCode: failed to create session: ${JSON.stringify(created.error)}`);
          }
          sessionId = created.data?.id;
          if (!sessionId) throw new Error('OpenCode: failed to create session (no id)');
          self.activeSessionId = sessionId;
        }

        if (!initYielded) {
          yield { type: 'init', continuation: sessionId };
          initYielded = true;
        }

        const promptRes = await client.session.promptAsync({
          path: { id: sessionId },
          body: { parts: [{ type: 'text', text }] },
        });
        if (promptRes.error) {
          self.activeSessionId = undefined;
          throw new Error(`OpenCode promptAsync: ${JSON.stringify(promptRes.error)}`);
        }

        const partTextByMessageId = new Map<string, string>();
        const roleByMessageId = new Map<string, string>();
        const reasoningEmittedLen = new Map<string, number>(); // reasoning partId → chars already surfaced
        const toolAnnounced = new Set<string>(); // tool callIDs already surfaced as tool_use
        let sawReasoning = false; // did the assistant emit any reasoning this turn?
        let lastEventAt = Date.now();
        let eventTimedOut = false;
        const timeoutCheck = setInterval(() => {
          if (Date.now() - lastEventAt > IDLE_TIMEOUT_MS) {
            log(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms) — clearing session ${sessionId}`);
            eventTimedOut = true;
            self.activeSessionId = undefined;
            destroySharedRuntime();
            kick();
          }
        }, 5000);

        try {
          turn: while (true) {
            if (aborted) return;
            if (eventTimedOut) {
              throw new Error(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms)`);
            }

            const { value: ev, done } = await stream.next();
            if (done) {
              throw new Error('OpenCode SSE stream ended unexpectedly');
            }

            if (!ev?.type || ev.type === 'server.connected' || ev.type === 'server.heartbeat') continue;

            lastEventAt = Date.now();
            yield { type: 'activity' };

            switch (ev.type) {
              case 'message.updated': {
                const info = ev.properties.info as { id?: string; role?: string } | undefined;
                if (info?.id && info?.role) {
                  roleByMessageId.set(info.id, info.role);
                }
                break;
              }
              case 'message.part.updated': {
                const part = ev.properties.part as
                  | {
                      type?: string;
                      id?: string;
                      messageID?: string;
                      text?: string;
                      tool?: string;
                      callID?: string;
                      state?: { status?: string; input?: Record<string, unknown> };
                    }
                  | undefined;
                if (part?.type === 'text' && part.messageID && part.text) {
                  partTextByMessageId.set(part.messageID, part.text);
                } else if (part?.type === 'reasoning' && part.id && typeof part.text === 'string') {
                  // Stream the agent's thinking to the rich activity feed (cosmetic —
                  // never the result). Parts carry the full accumulated text each
                  // update, so surface only the growth, throttled to natural chunks.
                  if (part.text) sawReasoning = true;
                  const seen = reasoningEmittedLen.get(part.id) ?? 0;
                  const grown = part.text.slice(seen);
                  if (grown.length >= REASONING_MIN_CHUNK || /[.!?\n]/.test(grown)) {
                    for (const line of reasoningChunks(grown)) yield { type: 'reasoning', message: line };
                    reasoningEmittedLen.set(part.id, part.text.length);
                  }
                } else if (part?.type === 'tool' && part.tool && part.callID) {
                  // Announce each tool call once, when it begins running — drives the
                  // bubble's "Using <tool>" verb + tool trace.
                  const status = part.state?.status;
                  if ((status === 'running' || status === 'completed') && !toolAnnounced.has(part.callID)) {
                    toolAnnounced.add(part.callID);
                    notifyProviderMessage({ kind: 'tool_use', toolName: part.tool, toolInput: part.state?.input });
                  }
                }
                break;
              }
              case 'permission.updated': {
                const perm = ev.properties as { id?: string; sessionID?: string };
                if (perm.sessionID === sessionId && perm.id) {
                  try {
                    await client.postSessionIdPermissionsPermissionId({
                      path: { id: sessionId, permissionID: perm.id },
                      body: { response: 'always' },
                    });
                  } catch (err) {
                    log(`Failed to auto-reply permission: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }
                break;
              }
              case 'session.status': {
                const props = ev.properties as {
                  sessionID?: string;
                  status?: { type?: string; attempt?: number; message?: string };
                };
                if (props.sessionID !== sessionId) break;
                const st = props.status;
                if (
                  st?.type === 'retry' &&
                  typeof st.attempt === 'number' &&
                  st.attempt >= SESSION_STATUS_RETRY_ERROR_AFTER &&
                  st.message
                ) {
                  self.activeSessionId = undefined;
                  throw new Error(`OpenCode retry limit (${st.attempt}): ${st.message}`);
                }
                break;
              }
              case 'session.error': {
                const props = ev.properties as { sessionID?: string; error?: unknown };
                if (props.sessionID === sessionId || props.sessionID === undefined) {
                  self.activeSessionId = undefined;
                  throw new Error(sessionErrorMessage(props));
                }
                break;
              }
              case 'session.idle': {
                const sid = (ev.properties as { sessionID?: string }).sessionID;
                if (sid === sessionId) {
                  break turn;
                }
                break;
              }
              default:
                break;
            }
          }
        } finally {
          clearInterval(timeoutCheck);
        }

        let resultText = '';
        for (const [msgId, role] of roleByMessageId) {
          if (role === 'assistant') {
            resultText = partTextByMessageId.get(msgId) ?? resultText;
          }
        }
        // Thinking-stall recovery: the model reasoned but produced no answer. Learn
        // that this model stalls (so later turns start thinking-off) and retry the
        // SAME prompt with thinking off — up to MAX_STALL_RETRIES, because a small
        // model can stall even with thinking off, so one retry isn't a guarantee.
        // The reasoning already streamed to the feed, so nothing's lost. Only retry
        // when reasoning was present (a genuine stall) vs. an intentionally silent
        // turn, which stays empty.
        if (!resultText && sawReasoning && item.retries < MAX_STALL_RETRIES) {
          thinkingOffModels.add(modelKey);
          log(
            `OpenCode: reasoning-only turn (no answer) on ${modelKey} — retry ${item.retries + 1}/${MAX_STALL_RETRIES} with thinking off`,
          );
          pending.unshift({ text: withThinkingOff(text), retries: item.retries + 1 });
          continue;
        }
        yield { type: 'result', text: resultText || null };
      }
    }

    return {
      push: (message: string) => {
        pending.push({ text: wrapPromptWithContext(message, systemInstructions), retries: 0 });
        kick();
      },
      end: () => {
        ended = true;
        kick();
      },
      events: gen(),
      abort: () => {
        aborted = true;
        this.activeSessionId = undefined;
        kick();
        destroySharedRuntime();
      },
    };
  }
}

registerProvider('opencode', (opts) => new OpenCodeProvider(opts));
