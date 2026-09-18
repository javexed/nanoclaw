/**
 * Provider seam — the registries providers notify with raw turn activity, so
 * consumers need no per-provider wiring. Three registries:
 *
 *   - message observer: raw activity (tool calls, turn boundaries, progress).
 *     The status feed consumes it; the learning loop counts tool calls off it.
 *   - query-options contributor: per-query option overrides a module wants the
 *     provider to apply. The learning loop uses it to run its review pass with
 *     a restricted toolset. Contributions merge, last wins, `{}` when nothing
 *     registers.
 *   - exchange observer: every completed prompt/result pair. The learning loop
 *     keeps its bounded digest from it.
 *
 * Contract: a registered hook must never break the call it observes; every
 * notify wraps each call in try/catch.
 */
import type { ProviderExchange, QueryInput } from './types.js';

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

/** Per-query overrides a module may ask the provider to apply. */
export interface ProviderQueryOptionsContribution {
  /** REPLACES the provider's tool allowlist for this query. */
  allowedTools?: string[];
  /** Overrides the turn model for this query. */
  model?: string;
  /** Run the query on a fork of the continuation, leaving the main transcript untouched. */
  forkSession?: boolean;
}

type QueryOptionsContributor = (input: QueryInput) => ProviderQueryOptionsContribution | null;

const queryOptionsContributors: QueryOptionsContributor[] = [];

export function registerProviderQueryOptionsContributor(fn: QueryOptionsContributor): void {
  queryOptionsContributors.push(fn);
}

export function resolveProviderQueryOptions(input: QueryInput): ProviderQueryOptionsContribution {
  const merged: ProviderQueryOptionsContribution = {};
  for (const fn of queryOptionsContributors) {
    try {
      const c = fn(input);
      if (!c) continue;
      // Only keys the contributor actually set — an explicit undefined must
      // not clobber an earlier contributor's value.
      for (const [k, v] of Object.entries(c)) {
        if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
      }
    } catch {
      // A contributor bug must never break the turn — skip its contribution.
    }
  }
  return merged;
}

type ProviderExchangeObserver = (exchange: ProviderExchange) => void;

const exchangeObservers: ProviderExchangeObserver[] = [];

export function registerProviderExchangeObserver(fn: ProviderExchangeObserver): void {
  exchangeObservers.push(fn);
}

export function notifyProviderExchange(exchange: ProviderExchange): void {
  for (const fn of exchangeObservers) {
    try {
      fn(exchange);
    } catch {
      // An observer bug must never break the exchange it observes.
    }
  }
}

/**
 * Snapshot every registry and return a restore function. bun runs every test
 * file in ONE process, so a test must never wipe registrations other modules
 * made at import time — it snapshots, registers its own, and restores.
 */
export function __snapshotProviderHooksForTest(): () => void {
  const m = [...messageObservers];
  const q = [...queryOptionsContributors];
  const x = [...exchangeObservers];
  return () => {
    messageObservers.length = 0;
    messageObservers.push(...m);
    queryOptionsContributors.length = 0;
    queryOptionsContributors.push(...q);
    exchangeObservers.length = 0;
    exchangeObservers.push(...x);
  };
}
