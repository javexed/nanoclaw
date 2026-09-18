/**
 * Runner-loop seam — two registries the poll loop consults so a module can
 * add a slash command and observe turn completion without the poll loop
 * knowing the module exists. Core registers nothing, so every call site is
 * inert: with no specs the scan matches nothing, with no observers the
 * notify is a no-op.
 *
 * Contract: a registered hook must never break a turn. matches(), execute()
 * and every observer call are individually try/caught. `matches` sees the
 * trimmed text of chat rows only, and only after the built-in commands
 * (/clear, /upload-trace) have declined — a spec cannot shadow a built-in.
 */
import type { MessageInRow } from './db/messages-in.js';
import type { RoutingContext } from './formatter.js';
import type { PollLoopConfig } from './poll-loop.js';

function log(msg: string): void {
  console.error(`[runner-hooks] ${msg}`);
}

/** The poll-loop locals a hook may need. `getContinuation` is read lazily —
 *  the loop reassigns the continuation when a turn's result lands. */
export interface RunnerTurnContext {
  config: PollLoopConfig;
  routing: RoutingContext;
  batchMessages: MessageInRow[];
  getContinuation: () => string | undefined;
}

export interface RunnerCommandSpec {
  matches: (text: string) => boolean;
  /** Runs at the batch idle point: after built-in command handling, before
   *  the empty-batch early exit. The row is already marked completed. */
  execute: (text: string, ctx: RunnerTurnContext) => Promise<void>;
}

const commands: RunnerCommandSpec[] = [];

export function registerRunnerCommand(spec: RunnerCommandSpec): void {
  commands.push(spec);
}

export function matchRunnerCommand(text: string): RunnerCommandSpec | null {
  for (const spec of commands) {
    try {
      if (spec.matches(text)) return spec;
    } catch {
      // A throwing matcher skips its own spec, never the scan.
    }
  }
  return null;
}

export interface DeferredRunnerCommand {
  spec: RunnerCommandSpec;
  text: string;
}

export async function runDeferredRunnerCommands(
  deferred: DeferredRunnerCommand[],
  ctx: RunnerTurnContext,
): Promise<void> {
  for (const d of deferred) {
    try {
      await d.spec.execute(d.text, ctx);
    } catch (err) {
      log(`command failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

type TurnCompletionObserver = (ctx: RunnerTurnContext) => void;
const turnObservers: TurnCompletionObserver[] = [];

export function registerTurnCompletionObserver(fn: TurnCompletionObserver): void {
  turnObservers.push(fn);
}

export function notifyTurnCompletion(ctx: RunnerTurnContext): void {
  for (const fn of turnObservers) {
    try {
      fn(ctx);
    } catch (err) {
      log(`turn observer failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** The trimmed `text` of a chat row, or null for anything else. */
export function chatRowText(msg: MessageInRow): string | null {
  if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') return null;
  try {
    const t = (JSON.parse(msg.content) as { text?: unknown }).text;
    return typeof t === 'string' ? t.trim() : null;
  } catch {
    return null;
  }
}

/** Test support: snapshot both registries, return a restore function. */
export function __snapshotRunnerHooksForTest(): () => void {
  const c = [...commands];
  const o = [...turnObservers];
  return () => {
    commands.length = 0;
    commands.push(...c);
    turnObservers.length = 0;
    turnObservers.push(...o);
  };
}
