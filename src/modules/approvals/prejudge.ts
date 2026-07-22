/**
 * Approval pre-judge (fork-owned) — an OPTIONAL LLM triage tier in front of
 * human approvals.
 *
 * When an approval hold is created, `maybePrejudgeApproval` (called from
 * `requestApproval`, see primitive.ts) can consult a locally-hosted roster
 * model (webchat_models) with a strict rubric: is this specific request
 * routine, low-stakes, and reversible? On a clean `approve` verdict the
 * approval is resolved through the EXACT same dispatch path a human Approve
 * click takes (response-handler's `resolveApprovalAsApproved`), the agent is
 * notified with an "Auto-approved (pre-judge)" marker, and an audit line is
 * logged. On ANYTHING else — model off, action not opted in, never-list hit,
 * timeout, non-200, unparseable output, or a non-approve verdict — the flow
 * falls through to normal human delivery, exactly as today.
 *
 * Conservative by construction:
 *   - OFF twice over by default: no model configured AND an empty opt-in
 *     action list. Both must be set (owner-only webchat API) before anything
 *     is pre-judged.
 *   - There is NO auto-deny. The model can only approve or escalate; deny
 *     stays human-only (a wrong auto-deny is worse than a wait).
 *   - A hardcoded never-list overrides the opt-in list — privilege,
 *     credential, and supply-chain changes always reach a human.
 *   - Every failure mode escalates. A broken model costs a wait, never an
 *     unattended action.
 *   - Per-request verdicts only — no caching.
 *
 * Docs: docs/webchat/approval-prejudge.md
 */
import {
  getApprovalPrejudgeActions,
  getApprovalPrejudgeModelId,
  getWebchatModel,
  type WebchatModel,
} from '../../channels/webchat/db.js';
import { anthropicMessagesViaOneCLI, type AnthropicMessagesCall } from '../../channels/webchat/drafter.js';
import { safeFetch } from '../../channels/webchat/models.js';
import { redactSensitiveData } from '../../channels/webchat/redact.js';
import { getPendingApproval } from '../../db/sessions.js';
import { log } from '../../log.js';
import type { PendingApproval, Session } from '../../types.js';
import { notifyAgent } from './primitive.js';
import { resolveApprovalAsApproved } from './response-handler.js';

// Short timeout: the pre-judge runs inline in requestApproval, so a slow
// model delays card delivery for everyone. A local model that can't answer
// in 10s isn't fit for triage — escalate.
export const PREJUDGE_TIMEOUT_MS = 10_000;

// Output cap for the anthropic-kind judge call — the verdict JSON is one
// short line, so a small budget keeps the (proxied) call fast and cheap.
export const PREJUDGE_ANTHROPIC_MAX_TOKENS = 256;

const MAX_PAYLOAD_CHARS = 2000;
const MAX_QUESTION_CHARS = 1000;
const MAX_REASON_CHARS = 300;

// ── Never-list ──
// Overrides the opt-in list. Actions and payload shapes that must ALWAYS
// reach a human, no matter what the owner opted in:
//   - onecli_credential  — credential use; also resolved via a different
//     (in-memory promise) path that this dispatcher cannot drive.
//   - install_packages   — supply chain: new code baked into the image.
//   - add_mcp_server     — new tool/capability surface for the agent.
// Payload patterns (matched against the RAW payload JSON, any action):
//   - cli_scope changes  — container privilege level.
//   - roles grant/revoke — user privilege.
//   - groups config verbs — container config (packages, MCP servers).
export const NEVER_AUTO_APPROVE_ACTIONS: ReadonlySet<string> = new Set([
  'onecli_credential',
  'install_packages',
  'add_mcp_server',
]);

export const NEVER_AUTO_APPROVE_PATTERNS: readonly RegExp[] = [
  /\bcli_scope\b/i,
  /\broles\s+(grant|revoke)\b/i,
  /\bconfig\s+(update|add-mcp-server|remove-mcp-server|add-package|remove-package)\b/i,
];

export function isNeverAutoApprovable(action: string, payloadJson: string): boolean {
  if (NEVER_AUTO_APPROVE_ACTIONS.has(action)) return true;
  return NEVER_AUTO_APPROVE_PATTERNS.some((re) => re.test(payloadJson));
}

// ── Prompt redaction ──
// Reuse the webchat redaction layer (redact.ts) and supplement the few
// agent-runner redactSecrets patterns it lacks (container/agent-runner/src/
// formatter.ts): bare Bearer tokens, OneCLI proxy tokens, MCP relay tokens.
const SUPPLEMENT_PATTERNS: readonly RegExp[] = [
  /\b(aoc_[A-Za-z0-9]{8,})/g, // OneCLI proxy tokens
  /\b(mcr_[A-Za-z0-9]{8,})/g, // MCP relay tokens
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
];

export function redactForPrompt(text: string): string {
  let out = redactSensitiveData(text);
  for (const re of SUPPLEMENT_PATTERNS) {
    out = out.replace(re, (_m, prefix: string) =>
      typeof prefix === 'string' && /^Bearer\s+$/i.test(prefix) ? `${prefix}[REDACTED]` : '[REDACTED]',
    );
  }
  return out;
}

// ── Rubric ──
// The system prompt sent to the triage model. Deliberately biased toward
// escalation: approve is only allowed for clearly routine, reversible
// requests, and the model is told it cannot reject anything.
export const PREJUDGE_RUBRIC = [
  'You are a pre-approval triage assistant for a personal automation system.',
  'An agent requested a privileged action that is normally held for a human approver.',
  'Your ONLY decision: is this specific request routine, low-stakes, and easily reversible?',
  '',
  'Rules:',
  '- If the action could change permissions, roles, credentials, installed software, or system configuration, respond escalate.',
  '- If the request is destructive, irreversible, unusual, ambiguous, or you are unsure for ANY reason, respond escalate.',
  '- Respond approve ONLY when the request is clearly routine and easily reversible.',
  '- You cannot reject a request. A human reviews everything you do not approve, so escalate is always safe.',
  '',
  'Respond with ONLY a JSON object — no prose, no code fences:',
  '{"verdict":"approve","reason":"<one short sentence>"} or {"verdict":"escalate","reason":"<one short sentence>"}',
].join('\n');

// ── Core ──

export interface PrejudgeResult {
  verdict: 'approve' | 'escalate';
  reason: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Model-kind gate — the single definition of "usable as a judge", shared by
 * the runtime path below and the webchat PUT validation (server.ts), so the
 * two can never drift:
 *   - `anthropic` kind: endpoint is NULL by design — the call routes through
 *     the OneCLI gateway (same credentialed path as the webchat drafter).
 *   - `ollama` / `openai-compatible`: need a reachable endpoint.
 */
export function isUsableJudgeModel(model: WebchatModel | undefined): model is WebchatModel {
  if (!model) return false;
  if (model.kind === 'anthropic') return true;
  return !!model.endpoint && (model.kind === 'ollama' || model.kind === 'openai-compatible');
}

/** Injectable seams for tests. Defaults are the real config/roster/fetch. */
export interface PrejudgeDeps {
  fetchFn?: FetchLike;
  /** Anthropic Messages call via the OneCLI proxy (anthropic-kind judges). */
  anthropicFn?: (call: AnthropicMessagesCall) => Promise<string>;
  getModelId?: () => string | null;
  getActions?: () => string[];
  getModel?: (id: string) => WebchatModel | undefined;
}

const escalate = (reason: string): PrejudgeResult => ({ verdict: 'escalate', reason });

/**
 * Parse the model's output into a verdict. Strict: after stripping an
 * optional single code fence, the content must be a JSON object whose
 * `verdict` is exactly `"approve"` — anything else (including `"deny"`,
 * `"reject"`, prose, truncation) escalates.
 */
export function parseVerdict(content: string): PrejudgeResult {
  const stripped = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return escalate('unparseable model output');
  }
  if (typeof parsed !== 'object' || parsed === null) return escalate('unparseable model output');
  const record = parsed as Record<string, unknown>;
  const reason =
    typeof record.reason === 'string' && record.reason.trim()
      ? redactForPrompt(record.reason.trim().slice(0, MAX_REASON_CHARS))
      : '';
  if (record.verdict === 'approve') {
    return { verdict: 'approve', reason: reason || 'model judged the request routine and reversible' };
  }
  return escalate(reason || 'model did not approve');
}

/**
 * Consult the configured triage model about one approval. Never throws; every
 * failure mode returns `{ verdict: 'escalate' }`. `question` is the human-
 * readable card body from requestApproval (not persisted on the row).
 */
export async function prejudgeApproval(
  approval: PendingApproval,
  question?: string,
  deps: PrejudgeDeps = {},
): Promise<PrejudgeResult> {
  const modelId = (deps.getModelId ?? getApprovalPrejudgeModelId)();
  if (!modelId) return escalate('pre-judge is not configured (no model)');
  const actions = (deps.getActions ?? getApprovalPrejudgeActions)();
  if (!actions.includes(approval.action)) return escalate('action is not opted in to pre-judge');
  // A targeted approval names its approver deliberately — never intercept.
  if (approval.approver_user_id) return escalate('approval targets a specific approver');
  if (isNeverAutoApprovable(approval.action, approval.payload)) {
    return escalate('action matches the never-auto-approve list');
  }
  const model = (deps.getModel ?? getWebchatModel)(modelId);
  if (!isUsableJudgeModel(model)) {
    return escalate('configured pre-judge model is unavailable');
  }

  const lines = [
    `Action: ${approval.action}`,
    `Title: ${redactForPrompt(approval.title)}`,
    question ? `Request: ${redactForPrompt(question.slice(0, MAX_QUESTION_CHARS))}` : null,
    `Payload: ${redactForPrompt(approval.payload.slice(0, MAX_PAYLOAD_CHARS))}`,
  ].filter((l): l is string => l !== null);

  try {
    if (model.kind === 'anthropic') {
      // Claude judge — the same OneCLI-proxied Messages call the webchat
      // drafter makes (drafter.ts): the host never holds a raw Anthropic
      // key. No temperature: current Claude models (Sonnet 5, Opus 4.7+)
      // reject non-default sampling params with a 400, which would turn
      // every consult into an escalation. Same timeout, same strict
      // verdict parsing, same fail-safes — any throw escalates below.
      const anthropicFn = deps.anthropicFn ?? anthropicMessagesViaOneCLI;
      const content = (
        await anthropicFn({
          model: model.model_id,
          system: PREJUDGE_RUBRIC,
          user: lines.join('\n'),
          maxTokens: PREJUDGE_ANTHROPIC_MAX_TOKENS,
          timeoutMs: PREJUDGE_TIMEOUT_MS,
        })
      ).trim();
      if (!content) return escalate('empty model response');
      return parseVerdict(content);
    }

    const fetchFn = deps.fetchFn ?? safeFetch;
    // Non-anthropic kinds passed isUsableJudgeModel, which requires an
    // endpoint for them — the assertion is guaranteed by the gate above.
    const res = await fetchFn(`${model.endpoint!.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model.model_id,
        temperature: 0,
        messages: [
          { role: 'system', content: PREJUDGE_RUBRIC },
          { role: 'user', content: lines.join('\n') },
        ],
      }),
      signal: AbortSignal.timeout(PREJUDGE_TIMEOUT_MS),
    });
    if (!res.ok) return escalate(`model returned ${res.status}`);
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content?.trim();
    if (!content) return escalate('empty model response');
    return parseVerdict(content);
    // eslint-disable-next-line no-catch-all/no-catch-all -- fail-safe contract: any error (timeout, network, JSON body) must escalate to a human, never propagate
  } catch (err) {
    return escalate(`model call failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Extra injectable seams for the short-circuit wiring (tests). */
export interface MaybePrejudgeDeps extends PrejudgeDeps {
  getApproval?: (approvalId: string) => PendingApproval | undefined;
  resolve?: (approval: PendingApproval, userId: string) => Promise<void>;
  notify?: (session: Session, text: string) => void;
}

/**
 * The requestApproval hook. Returns `true` when the approval was auto-
 * approved and fully resolved (caller must skip card delivery), `false` in
 * every other case (caller proceeds exactly as today). Never throws.
 */
export async function maybePrejudgeApproval(
  approvalId: string,
  session: Session,
  question?: string,
  deps: MaybePrejudgeDeps = {},
): Promise<boolean> {
  try {
    const modelId = (deps.getModelId ?? getApprovalPrejudgeModelId)();
    if (!modelId) return false; // feature off — zero overhead, no logging
    const approval = (deps.getApproval ?? getPendingApproval)(approvalId);
    if (!approval) return false;
    const actions = (deps.getActions ?? getApprovalPrejudgeActions)();
    if (!actions.includes(approval.action)) return false; // not opted in — silent

    const result = await prejudgeApproval(approval, question, deps);
    if (result.verdict !== 'approve') {
      log.info('Approval pre-judge escalated to human', {
        action: approval.action,
        approvalId,
        model: modelId,
        reason: result.reason,
      });
      return false;
    }

    // Audit line FIRST, then the agent-visible marker, then the same dispatch
    // a human Approve takes (claim → handler → resolved-callbacks → wake).
    log.info('Approval auto-approved (pre-judge)', {
      action: approval.action,
      approvalId,
      model: modelId,
      reason: result.reason,
    });
    (deps.notify ?? notifyAgent)(session, `Auto-approved (pre-judge): ${result.reason}`);
    await (deps.resolve ?? resolveApprovalAsApproved)(approval, `prejudge:${modelId}`);
    return true;
    // eslint-disable-next-line no-catch-all/no-catch-all -- fail-safe contract: a pre-judge crash must fall through to normal human delivery
  } catch (err) {
    log.error('Approval pre-judge failed — falling back to human approval', { approvalId, err });
    return false;
  }
}
