/**
 * Learning loop — the agent distills a reusable lesson from its own session
 * into a SKILL.md draft; a human keeps or discards it from the room.
 *
 * Everything the loop layers onto the poll loop lives here and attaches
 * through the runner and provider seams (runner-hooks.ts, providers/hooks.ts),
 * so the poll loop and the provider keep only thin call sites:
 *
 *   /learn          an explicit trigger — an isolated review pass at the
 *                   batch idle point, with the toolset dropped to draft_skill
 *                   alone. The user's trailing text steers the review.
 *   auto-trigger    the same review, fired by the loop itself after a busy
 *                   turn (≥ AUTO_REVIEW_MIN_TOOLS tool calls), bounded by a
 *                   per-container cooldown. Per agent, default on. Silent on
 *                   decline — only a real draft announces itself.
 *
 * The review runs over a bounded DIGEST of the recent exchanges as a fresh
 * query — nothing is replayed, and the main conversation is untouched by
 * construction. draft_skill emits a `propose_skill` action; the host stages
 * it and drops a Keep/Discard card in the room.
 */
import type { MessageInRow } from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import { getOutboundDb } from './mailbox/sqlite/connection.js';
import { appendStatusEvent } from './status-feed.js';
import {
  registerProviderExchangeObserver,
  registerProviderMessageObserver,
  registerProviderQueryOptionsContributor,
} from './providers/hooks.js';
import { registerRunnerCommand, registerTurnCompletionObserver, type RunnerTurnContext } from './runner-hooks.js';
import type { ProviderExchange, QueryInput } from './providers/types.js';
import type { RoutingContext } from './formatter.js';
import { LEARNING_REVIEW_PROMPT } from './mcp-tools/draft-skill.js';
import { dispatchResultText, type PollLoopConfig } from './poll-loop.js';

function log(msg: string): void {
  console.error(`[learning] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Learning-loop behavior from container.json. Absent keys mean defaults. */
export interface LearningConfig {
  /** Busy turns auto-run the review. Default true — it only ever STAGES a draft. */
  autoTrigger?: boolean;
  /** Minimum gap between auto reviews per container. Default 30. */
  cooldownMinutes?: number;
  /** Model for the review pass (alias or full id). Overrides NANOCLAW_LEARNING_MODEL. */
  reviewModel?: string;
}

// ── The review prompt ────────────────────────────────────────────────────────

/**
 * The prompt for an explicit `/learn`. Anything after `/learn` is the user
 * steering the review ("/learn keep the rsync part even though it's
 * well-known") — replacing it wholesale with the authoring prompt would throw
 * their words away. Their steering may override "too well-known to keep";
 * it never overrides the denylist or the no-invention rule.
 */
export function buildLearnReviewPrompt(text: string): string {
  const hint = text.replace(/^\/learn\b/i, '').trim();
  if (!hint) return LEARNING_REVIEW_PROMPT;
  return (
    `${LEARNING_REVIEW_PROMPT}\n\n` +
    `The user added this when asking for the review — treat it as steering: "${hint}". ` +
    `It may override a judgment that something is too well-known to keep. ` +
    `It never overrides the list of things not to draft, and never licenses inventing flags, paths, or APIs.`
  );
}

// ── The exchange digest ──────────────────────────────────────────────────────

export interface ExchangeRecord {
  prompt: string;
  result: string | null;
}

export interface ExchangeLog {
  entries: ExchangeRecord[];
}

/** How many recent exchanges the log retains (and a digest may include). */
export const DIGEST_MAX_EXCHANGES = 12;
/** Overall digest budget, chars (~6k tokens) — the hard bound on review input. */
export const DIGEST_MAX_CHARS = 24_000;
/** Per prompt/result field budget, chars; long fields keep head + tail. */
export const DIGEST_ENTRY_MAX_CHARS = 4_000;

const DIGEST_SEPARATOR = '\n\n---\n\n';

export function createExchangeLog(): ExchangeLog {
  return { entries: [] };
}

export function recordExchange(log: ExchangeLog, exchange: { prompt: string; result: string | null }): void {
  log.entries.push({ prompt: exchange.prompt, result: exchange.result });
  if (log.entries.length > DIGEST_MAX_EXCHANGES) log.entries.splice(0, log.entries.length - DIGEST_MAX_EXCHANGES);
}

/** Head+tail truncation: keep the opening and the ending, cut the middle. */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = `\n… [${text.length - max} chars truncated] …\n`;
  const keep = max - marker.length;
  if (keep <= 0) return text.slice(0, max);
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}

function formatExchange(ex: ExchangeRecord): string {
  const result = ex.result && ex.result.trim() ? ex.result : '(no reply text)';
  return (
    `[user → agent]\n${truncateMiddle(ex.prompt, DIGEST_ENTRY_MAX_CHARS)}\n\n` +
    `[agent]\n${truncateMiddle(result, DIGEST_ENTRY_MAX_CHARS)}`
  );
}

/**
 * Bounded digest of the recent exchanges, oldest first. Newest exchanges win
 * when the budget runs out (they triggered the review). Null when the log is
 * empty — the review then runs as a plain fresh query.
 */
export function buildReviewDigest(log: ExchangeLog): string | null {
  if (log.entries.length === 0) return null;
  const blocks: string[] = [];
  let total = 0;
  for (let i = log.entries.length - 1; i >= 0; i--) {
    const block = formatExchange(log.entries[i]);
    const cost = block.length + (blocks.length > 0 ? DIGEST_SEPARATOR.length : 0);
    if (blocks.length > 0 && total + cost > DIGEST_MAX_CHARS) break;
    blocks.unshift(block);
    total += cost;
  }
  // Belt-and-braces: per-entry caps keep any single block far below the
  // budget, but the bound advertised to callers must hold unconditionally.
  return blocks.join(DIGEST_SEPARATOR).slice(0, DIGEST_MAX_CHARS);
}

export function buildDigestReviewPrompt(reviewPrompt: string, digest: string): string {
  return (
    `${reviewPrompt}\n\n` +
    `You are running as a separate review pass and the full session transcript is NOT in your context. ` +
    `Review the digest below instead: the most recent exchanges of the session, oldest first, long entries ` +
    `truncated in the middle. Treat it as the session — the same trust rules apply, and if the digest does ` +
    `not show enough to meet the bar, that is a normal "nothing worth keeping".\n\n` +
    `<session-digest>\n${digest}\n</session-digest>`
  );
}

/** The configured review model, if set: trimmed, empty = unset. */
export function resolveReviewModel(learning: LearningConfig | undefined): string | undefined {
  const m = typeof learning?.reviewModel === 'string' ? learning.reviewModel.trim() : '';
  return m || undefined;
}

// ── The auto-trigger decision ────────────────────────────────────────────────

/** A turn is "busy" — worth a review — from this many tool calls. */
export const AUTO_REVIEW_MIN_TOOLS = 5;

/**
 * Pure. Auto-trigger is on unless disabled — it only ever STAGES a draft, so
 * the human gate survives at Keep. The guards are about cost and noise: the
 * turn must have been busy, a per-container cooldown bounds spend on chatty
 * rooms, a turn that was itself a /learn never re-triggers, and the provider
 * must support the restricted pass — nobody is watching an auto review, so it
 * never falls back to the full toolset.
 */
export function shouldAutoReview(args: {
  learning: LearningConfig | undefined;
  supportsRestrictedReview: boolean;
  toolCount: number;
  hadLearnCommand: boolean;
  lastAutoReviewAt: number | null;
  now: number;
}): boolean {
  const { learning, supportsRestrictedReview, toolCount, hadLearnCommand, lastAutoReviewAt, now } = args;
  if (learning?.autoTrigger === false) return false;
  if (!supportsRestrictedReview) return false;
  if (hadLearnCommand) return false;
  if (toolCount < AUTO_REVIEW_MIN_TOOLS) return false;
  const cooldownMs = (learning?.cooldownMinutes ?? 30) * 60_000;
  if (lastAutoReviewAt !== null && now - lastAutoReviewAt < cooldownMs) return false;
  return true;
}

export interface AutoReviewState {
  lastAutoReviewAt: number | null;
  inFlight: boolean;
}

export function createAutoReviewState(): AutoReviewState {
  return { lastAutoReviewAt: null, inFlight: false };
}

// ── The review pass ──────────────────────────────────────────────────────────

export type LearningReviewOutcome = 'proposed' | 'declined' | 'error';

function maxOutboundSeq(): number {
  const row = getOutboundDb().prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM messages_out').get() as { s: number };
  return row.s;
}

/** True when a propose_skill row landed in messages_out after `seq`. */
export function hasSkillProposalSince(seq: number): boolean {
  // draft_skill runs in the MCP subprocess, so the signal crosses processes
  // the way everything here does: through the outbound DB. `action` is the
  // first key the tool's JSON.stringify emits, so the LIKE is stable.
  const row = getOutboundDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM messages_out
       WHERE seq > ? AND kind = 'system' AND content LIKE '%"action":"propose_skill"%'`,
    )
    .get(seq) as { c: number };
  return row.c > 0;
}

/**
 * A second provider query with the toolset dropped to draft_skill alone — the
 * review can propose a skill and say one sentence, and can do nothing else.
 *
 * Context comes from one of two places. DEFAULT: the exchange digest, as a
 * FRESH query — nothing replayed, a few thousand tokens, the main
 * conversation untouched by construction. FALLBACK, when no exchange has
 * been recorded yet (a container whose first message was /learn): fork the
 * live continuation so the full transcript is in context; the fork's own
 * session id is discarded, so the next real turn resumes the main
 * conversation unaware the review happened.
 */
export async function runLearningReview(
  config: PollLoopConfig,
  routing: RoutingContext,
  reviewPrompt: string,
  opts: { announceDecline?: boolean; digest?: string | null; continuation?: string } = {},
): Promise<LearningReviewOutcome> {
  const announceDecline = opts.announceDecline !== false;
  const digest = opts.digest ?? null;
  const seqBefore = maxOutboundSeq();
  let sawError = false;
  appendStatusEvent('start', null);
  const reviewInput: QueryInput = {
    prompt: digest !== null ? buildDigestReviewPrompt(reviewPrompt, digest) : reviewPrompt,
    continuation: digest !== null ? undefined : opts.continuation,
    cwd: config.cwd,
    systemContext: config.systemContext,
    moduleInput: { learningReview: true, reviewModel: resolveReviewModel(config.learning) },
  };
  const query = config.provider.query(reviewInput);
  try {
    for await (const event of query.events) {
      if (event.type !== 'activity') {
        log(`review: ${event.type}${event.type === 'error' ? ` — ${event.message}` : ''}`);
      }
      if (event.type === 'result') {
        if (event.text) {
          // Auto reviews stay SILENT unless they found something — the in-room
          // draft card is the announcement. "Nothing worth keeping" after every
          // busy turn is noise nobody asked for.
          if (!announceDecline) {
            query.end();
            continue;
          }
          const { sent } = await dispatchResultText(event.text, routing);
          if (sent === 0) {
            // A review's outcome is ALWAYS for the room that pressed /learn — an
            // unwrapped one-liner here is the normal shape, not scratchpad.
            await writeMessageOut({
              id: generateId(),
              kind: 'chat',
              platform_id: routing.platformId,
              channel_type: routing.channelType,
              thread_id: routing.threadId,
              content: JSON.stringify({ text: event.text }),
            });
          }
        }
        query.end(); // no follow-ups ever — let the SDK wind down
      } else if (event.type === 'error' && !event.retryable) {
        // Say so in the room. Silently logging leaves the user a thinking
        // bubble that ends in nothing.
        sawError = true;
        log(`review failed: ${event.message}`);
        await writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({
            text: `Couldn't run the skill review (${event.message}). Nothing was lost — send /learn again in a bit.`,
          }),
        });
        break;
      }
      // `init` carries the review's own session id. NOT saved, on purpose: the
      // next real turn must resume the main conversation, unaware of this pass.
    }
  } catch (err) {
    sawError = true;
    log(`review error: ${err instanceof Error ? err.message : String(err)}`);
    query.abort();
  } finally {
    appendStatusEvent('done', null);
  }
  // A draft outranks a late error: if propose_skill fired, the review was not
  // dry, whatever happened to the stream afterwards.
  if (hasSkillProposalSince(seqBefore)) return 'proposed';
  return sawError ? 'error' : 'declined';
}

// ── Seam registrations ───────────────────────────────────────────────────────

/** The provider options for a review query: draft_skill alone, optional cheaper model. */
export function learningReviewQueryOptions(
  input: QueryInput,
): { allowedTools: string[]; model?: string; forkSession?: boolean } | null {
  const m = input.moduleInput as { learningReview?: boolean; reviewModel?: string } | undefined;
  if (m?.learningReview !== true) return null;
  return {
    allowedTools: ['mcp__nanoclaw__draft_skill'],
    model: m.reviewModel || process.env.NANOCLAW_LEARNING_MODEL || undefined,
    forkSession: input.continuation ? true : undefined,
  };
}
registerProviderQueryOptionsContributor(learningReviewQueryOptions);

/** Narrow check for /learn — the loop's explicit trigger. */
export function isLearnCommand(text: string): boolean {
  return /^\/learn\b/i.test(text.trim());
}

// State — container-scoped, one runner process per container.
const autoReviewState = createAutoReviewState();
const exchangeLog = createExchangeLog();
let turnToolCount = 0;
let hadLearnCommand = false;

// Every completed exchange lands in the digest log.
registerProviderExchangeObserver((exchange: ProviderExchange) => recordExchange(exchangeLog, exchange));

// Tool calls per turn, counted off the provider seam. batch_start (a fresh
// batch, before the command scan) and turn_start both reset — the count that
// reaches the turn-completion observer is the just-finished turn's.
registerProviderMessageObserver((ev) => {
  if (ev.kind === 'batch_start') {
    turnToolCount = 0;
    hadLearnCommand = false;
  } else if (ev.kind === 'turn_start') {
    turnToolCount = 0;
  } else if (ev.kind === 'tool_use') {
    turnToolCount += 1;
  }
});

// `/learn` — deferred to the batch idle point, run as the restricted pass.
registerRunnerCommand({
  matches: isLearnCommand,
  execute: async (text: string, ctx: RunnerTurnContext) => {
    hadLearnCommand = true;
    if (!ctx.config.provider.supportsRestrictedReview) {
      log('/learn ignored — this provider cannot run a restricted review');
      return;
    }
    log('Learning review requested (/learn)');
    await runLearningReview(ctx.config, ctx.routing, buildLearnReviewPrompt(text), {
      digest: buildReviewDigest(exchangeLog),
      continuation: ctx.getContinuation(),
    });
  },
});

// Auto-trigger — after each turn, fire-and-forget with an in-flight guard so
// the loop never stalls and reviews never stack.
registerTurnCompletionObserver((ctx: RunnerTurnContext) => {
  if (autoReviewState.inFlight) return;
  if (
    !shouldAutoReview({
      learning: ctx.config.learning,
      supportsRestrictedReview: ctx.config.provider.supportsRestrictedReview === true,
      toolCount: turnToolCount,
      hadLearnCommand,
      lastAutoReviewAt: autoReviewState.lastAutoReviewAt,
      now: Date.now(),
    })
  )
    return;
  autoReviewState.inFlight = true;
  autoReviewState.lastAutoReviewAt = Date.now();
  const toolCount = turnToolCount;
  void (async () => {
    try {
      log(`Auto learning review (turn used ${toolCount} tools)`);
      await runLearningReview(ctx.config, ctx.routing, LEARNING_REVIEW_PROMPT, {
        announceDecline: false,
        digest: buildReviewDigest(exchangeLog),
        continuation: ctx.getContinuation(),
      });
    } catch (err) {
      log(`Auto learning review failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      autoReviewState.inFlight = false;
    }
  })();
});

/** Test support. */
export function __resetLearningStateForTest(): void {
  autoReviewState.lastAutoReviewAt = null;
  autoReviewState.inFlight = false;
  exchangeLog.entries.length = 0;
  turnToolCount = 0;
  hadLearnCommand = false;
}
export function __getTurnToolCountForTest(): number {
  return turnToolCount;
}
