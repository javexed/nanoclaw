/**
 * Provider message seam — the one registry providers notify with raw turn
 * activity, so consumers (the status feed) need no per-provider wiring.
 *
 * The predecessor's seam carried three registries (message observer, query-
 * options contributor, exchange observer); nanoclaw-web keeps only the
 * message observer — the other two served the learning loop, which was
 * dropped. Contract: a registered observer must never break the tool call it
 * observes; notify wraps every call in try/catch.
 */

/**
 * Raw provider activity surfaced to observers. `tool_use` fires from the
 * provider's pre-tool hook with the tool's name and (unredacted, in-container)
 * input — anything forwarded host-ward relies on the host-side redaction
 * pass. `batch_start` fires when a message batch is accepted for processing;
 * `turn_start`/`turn_done` fire at query-turn boundaries (`resetFeed` marks a
 * follow-up sub-turn inside a long-lived query, where a feed consumer should
 * cycle its display); `progress`/`reasoning` forward the provider-event
 * stream's cosmetic lines.
 */
export type ProviderMessageEvent =
  | { kind: 'tool_use'; toolName: string; toolInput?: Record<string, unknown> }
  | { kind: 'batch_start' }
  | { kind: 'turn_start'; resetFeed?: boolean }
  | { kind: 'turn_done' }
  | { kind: 'progress'; text: string }
  | { kind: 'reasoning'; text: string };

type ProviderMessageObserver = (ev: ProviderMessageEvent) => void;

const messageObservers: ProviderMessageObserver[] = [];

export function registerProviderMessageObserver(fn: ProviderMessageObserver): void {
  messageObservers.push(fn);
}

export function notifyProviderMessage(ev: ProviderMessageEvent): void {
  for (const fn of messageObservers) {
    try {
      fn(ev);
    } catch {
      // An observer bug must never break the tool call it observes.
    }
  }
}

/**
 * Snapshot the registry and return a restore function. bun runs every test
 * file in ONE process, so a test must never wipe registrations other modules
 * made at import time — it snapshots, registers its own, and restores.
 */
export function __snapshotProviderHooksForTest(): () => void {
  const observers = [...messageObservers];
  return () => {
    messageObservers.length = 0;
    messageObservers.push(...observers);
  };
}
