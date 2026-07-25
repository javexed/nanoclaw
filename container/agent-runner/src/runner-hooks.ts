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
import type { AgentProvider } from './providers/types.js';
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
  if (!spec.execute) return;
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
  return () => {
    commandSpecs.length = 0;
    commandSpecs.push(...specs);
    turnObservers.length = 0;
    turnObservers.push(...observers);
  };
}
