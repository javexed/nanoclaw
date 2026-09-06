/**
 * Runner-loop seam — registries installed modules use to hook the poll loop's
 * command handling and turn lifecycle WITHOUT patching poll-loop code.
 *
 * Core ships with nothing registered, so every call-site is inert: with no
 * command specs the command scan matches nothing, and with no turn observers
 * the per-turn notify is a no-op. A module (e.g. a learning loop) self-registers
 * at import time from its own file — poll-loop stays byte-identical whether or
 * not the module is installed.
 *
 * Contract notes:
 *  - A registered hook must never break a turn: matches/classify/execute and
 *    observer calls are individually try/caught. A throwing matches() skips
 *    that spec; a throwing classify() lets the row flow through as a normal
 *    message; a throwing execute() logs and moves on.
 *  - `matches` sees the trimmed text of chat/chat-sdk rows only, and only
 *    after the built-in commands (/clear, upload-trace) have declined — a
 *    spec cannot shadow a built-in.
 *  - Registered commands are slash commands, which categorizeMessage() already
 *    classes as `passthrough` — so isRunnerCommand()'s follow-up stream-break
 *    covers them with no formatter change.
 */
import type { MessageInRow } from './db/messages-in.js';
import type { RoutingContext } from './formatter.js';
import type { AgentProvider, AgentQuery } from './providers/types.js';
import type { PollLoopConfig } from './poll-loop.js';

function log(msg: string): void {
  console.error(`[runner-hooks] ${msg}`);
}

// ── R3: runner command registry ──────────────────────────────────────────────

/**
 * How a matched command row is consumed. `defer` takes the row out of the
 * batch now (marked completed with the other command rows) and runs the
 * spec's execute() at the batch idle point — after built-in command handling,
 * before the empty-batch early-exit. `rewrite` keeps the row in the batch
 * with its text replaced — the inline fallback for providers that can't
 * support the deferred treatment.
 */
export type RunnerCommandDecision = { action: 'defer' } | { action: 'rewrite'; text: string };

/**
 * Batch context handed to seam hooks (deferred command execution and per-turn
 * observers). One object per accepted batch.
 */
export interface RunnerTurnContext {
  routing: RoutingContext;
  /** The batch's rows as accepted, before command extraction. Snapshot — not
   *  mutated after the batch is built. */
  batchMessages: MessageInRow[];
  /** Read LAZILY: the loop reassigns its continuation as turn results land,
   *  and a hook must see the value as of when it actually runs. */
  getContinuation: () => string | undefined;
  /** The loop's own config (provider, cwd, systemContext, …). Read-only by
   *  contract — hooks observe and run their own queries; they don't steer
   *  the loop. */
  config: PollLoopConfig;
}

export interface RunnerCommandSpec {
  /** Match on the trimmed text of a chat/chat-sdk row (e.g. /^\/learn\b/i). */
  matches(text: string): boolean;
  classify(text: string, ctx: { provider: AgentProvider }): RunnerCommandDecision;
  /** Runs (awaited) at the batch idle point for each deferred row. */
  execute?(text: string, ctx: RunnerTurnContext): Promise<void>;
}

const commandSpecs: RunnerCommandSpec[] = [];

export function registerRunnerCommand(spec: RunnerCommandSpec): void {
  commandSpecs.push(spec);
}

/** First spec whose matches(text) is true; a throwing matches() skips its spec. */
export function matchRunnerCommand(text: string): RunnerCommandSpec | null {
  for (const spec of commandSpecs) {
    try {
      if (spec.matches(text)) return spec;
    } catch {
      // A spec bug must never break the batch — skip it.
    }
  }
  return null;
}

/** null when classify() throws — the caller lets the row flow through unconsumed. */
export function classifyRunnerCommand(
  spec: RunnerCommandSpec,
  text: string,
  ctx: { provider: AgentProvider },
): RunnerCommandDecision | null {
  try {
    return spec.classify(text, ctx);
  } catch (err) {
    log(`runner command classify() failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function runDeferredRunnerCommand(
  spec: RunnerCommandSpec,
  text: string,
  ctx: RunnerTurnContext,
): Promise<void> {
  if (!spec.execute) {
    // A defer with no execute() consumes the row and does nothing — almost
    // certainly a module bug (rewrite is the no-execute path). Make the
    // black hole visible in the container log.
    log(`deferred runner command consumed with no execute(): ${text.split(/\s/)[0]}`);
    return;
  }
  try {
    await spec.execute(text, ctx);
  } catch (err) {
    log(`runner command execute() failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── R3: turn-completion observers ────────────────────────────────────────────

/**
 * Fires each time a TURN completes (each provider result event). Hub-style
 * sessions hold one query open for hours, so anything reacting per-turn —
 * e.g. a learning auto-trigger — hooks here rather than after processQuery
 * returns. Observers must return synchronously and fire their own async work
 * without making the event drain wait: the notify is not awaited.
 */
type TurnCompletionObserver = (ctx: RunnerTurnContext) => void;

const turnObservers: TurnCompletionObserver[] = [];

export function registerTurnCompletionObserver(fn: TurnCompletionObserver): void {
  turnObservers.push(fn);
}

export function notifyTurnCompletion(ctx: RunnerTurnContext): void {
  for (const fn of turnObservers) {
    try {
      fn(ctx);
    } catch {
      // An observer bug must never break the turn it observes.
    }
  }
}

// ── R5: turn-retry handlers ──────────────────────────────────────────────────

/**
 * A turn that failed. `message` is the failure text as the user would see it;
 * `classification` carries the provider's own label when it supplies one
 * ('config', 'network', 'quota', …).
 */
export interface TurnFailure {
  message: string;
  classification?: string;
}

/**
 * Context for a retry decision. `retryWith` re-runs THIS turn on a different
 * provider — fresh session, single turn — with core owning the query
 * lifecycle; the handler only chooses the provider. Returns the retry's
 * result, or null if the retry itself failed to produce one.
 */
export interface TurnRetryContext {
  failure: TurnFailure;
  /** The prompt the failed turn was given, verbatim. */
  prompt: string;
  routing: RoutingContext;
  /** The loop's config (provider, cwd, systemContext, …). Read-only by contract. */
  config: PollLoopConfig;
  retryWith(provider: AgentProvider, providerName: string): Promise<unknown | null>;
}

/**
 * Handlers consulted when a turn fails. Returning a non-null result claims the
 * failure — the loop uses that result instead of surfacing the error, and no
 * further handler runs. Returning null (or throwing — isolated, logged) falls
 * through to the next handler and then to core's normal error path.
 *
 * The shipped consumer is provider escalation: a routing module retries a
 * turn its cheap/local provider failed on a stronger fallback. Note what the
 * seam deliberately does NOT decide — whether retrying is worth the money.
 * Retries cost real quota and a crafted prompt stream can fail a primary
 * model on purpose, so a handler that spends must impose its own cap
 * (a consecutive-failure counter in module scope, reset on a clean turn).
 * Core cannot know a provider's price; the module can.
 */
type TurnRetryHandler = (ctx: TurnRetryContext) => Promise<unknown | null>;

const turnRetryHandlers: TurnRetryHandler[] = [];

export function registerTurnRetryHandler(fn: TurnRetryHandler): void {
  turnRetryHandlers.push(fn);
}

/** First handler to return non-null claims the failure; a thrower is skipped. */
export async function runTurnRetryHandlers(ctx: TurnRetryContext): Promise<unknown | null> {
  for (const fn of turnRetryHandlers) {
    try {
      const out = await fn(ctx);
      if (out) return out;
    } catch (err) {
      log(`turn retry handler failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return null;
}

// ── poll-loop helpers ─────────────────────────────────────────────────────────
// The two larger pieces of seam logic the poll loop calls, kept here so its
// own insertion points stay to a few lines each.

/**
 * Parse a chat/chat-sdk row's JSON content for the command scan. Returns the
 * parsed object plus its trimmed text, or null on malformed JSON (the row
 * then flows through as a normal message).
 */
function parseChatContent(msg: MessageInRow): { content: Record<string, unknown>; text: string } | null {
  try {
    const content = JSON.parse(msg.content) as Record<string, unknown>;
    return { content, text: String(content.text ?? '').trim() };
  } catch {
    return null;
  }
}

export type RunnerCommandScan =
  | { action: 'defer'; spec: RunnerCommandSpec; text: string }
  | { action: 'rewrite'; msg: MessageInRow }
  | null;

/**
 * Module-registered commands, consulted after the built-ins decline. `defer`
 * consumes the row now and runs execute() at the loop's idle point; `rewrite`
 * keeps the row in the batch with its text replaced. Nothing registered — or
 * not a slash command, or classify() threw — returns null and the row flows
 * through untouched.
 */
export function scanRunnerCommand(msg: MessageInRow, provider: AgentProvider): RunnerCommandScan {
  if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') return null;
  const parsed = parseChatContent(msg);
  if (!parsed || !parsed.text.startsWith('/')) return null;
  const spec = matchRunnerCommand(parsed.text);
  if (!spec) return null;
  const decision = classifyRunnerCommand(spec, parsed.text, { provider });
  if (decision?.action === 'defer') {
    log(`Deferred runner command: ${parsed.text.split(/\s/)[0]}`);
    return { action: 'defer', spec, text: parsed.text };
  }
  if (decision?.action === 'rewrite') {
    return { action: 'rewrite', msg: { ...msg, content: JSON.stringify({ ...parsed.content, text: decision.text }) } };
  }
  return null;
}

/**
 * Turn-retry seam: a module may re-run a failed turn on a different provider
 * — e.g. a routing module escalating a turn its cheap provider failed. Core
 * owns the query lifecycle (fresh session, single turn, wrapped to stop at
 * the first result so a retry can never hold the loop open the way a hub
 * query does); the handler only picks the provider and owns its own spend
 * cap. `run` is the loop's processQuery, bound to the failed turn's context.
 * Returns the retry's result, or null when no handler claimed the failure or
 * the retry itself failed.
 */
export async function retryTurnAfterFailure<R>(ctx: {
  failure: TurnFailure;
  prompt: string;
  routing: RoutingContext;
  config: PollLoopConfig;
  run: (query: AgentQuery, providerName: string, provider: AgentProvider) => Promise<R>;
}): Promise<R | null> {
  return (await runTurnRetryHandlers({
    failure: ctx.failure,
    prompt: ctx.prompt,
    routing: ctx.routing,
    config: ctx.config,
    retryWith: async (provider, providerName) => {
      log(`Turn retry on ${providerName} (fresh session, single turn)`);
      const q = provider.query({
        prompt: ctx.prompt,
        continuation: undefined,
        cwd: ctx.config.cwd,
        systemContext: ctx.config.systemContext,
      });
      const singleTurn: AgentQuery = {
        push: (m) => q.push(m),
        end: () => q.end(),
        abort: () => q.abort(),
        events: (async function* () {
          for await (const ev of q.events) {
            yield ev;
            if (ev.type === 'result') break;
          }
          q.end();
        })(),
      };
      try {
        return await ctx.run(singleTurn, providerName, provider);
      } catch (retryErr) {
        log(`Retry on ${providerName} failed too: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
        return null;
      }
    },
  })) as R | null;
}

// ── test support ──────────────────────────────────────────────────────────────

/**
 * Snapshot both registries and return a restore function. bun runs every test
 * file in ONE process, so a test must never wipe registrations other modules
 * made at import time — it snapshots, registers its own hooks, and restores.
 * Not for runtime use.
 */
export function __snapshotRunnerHooksForTest(): () => void {
  const specs = [...commandSpecs];
  const observers = [...turnObservers];
  const retries = [...turnRetryHandlers];
  return () => {
    commandSpecs.length = 0;
    commandSpecs.push(...specs);
    turnObservers.length = 0;
    turnObservers.push(...observers);
    turnRetryHandlers.length = 0;
    turnRetryHandlers.push(...retries);
  };
}
