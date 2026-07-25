/**
 * Provider seam — registries installed modules use to observe provider
 * activity and contribute per-query options WITHOUT patching provider code.
 *
 * Core ships with nothing registered, so every call-site is inert: observers
 * default to none (notify is a no-op) and contributors default to none
 * (resolve returns {}). A module (e.g. the webchat status feed, the learning
 * loop) self-registers at import time from its own file — provider files stay
 * byte-identical whether or not the module is installed.
 *
 * Contract notes:
 *  - A registered function must never break a turn: notify/resolve wrap every
 *    call in try/catch and skip a throwing hook's contribution.
 *  - Contributions merge in registration order (later wins per key), same as
 *    the host-side container-config augmentors.
 */
import type { ProviderExchange, QueryInput } from './types.js';

/** Bumped when a registry signature changes — external consumers pin a range. */
export const SEAM_API_VERSION = 2;

// ── R2: per-query options contributor ────────────────────────────────────────

/**
 * Options a module may contribute for one query, merged over the provider's
 * own defaults (`undefined` keys leave the default in place). Shapes shared by
 * providers: an allowlist REPLACES the provider's default toolset; `model`
 * overrides the configured turn model; `forkSession` asks session-forking
 * providers to keep the query off the main transcript.
 */
export interface ProviderQueryOptionsContribution {
  allowedTools?: string[];
  model?: string;
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
      // Only copy keys the contributor actually set — an explicit undefined
      // must not clobber an earlier contributor's value.
      for (const [k, v] of Object.entries(c)) {
        if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
      }
    } catch {
      // A contributor bug must never break the turn — skip its contribution.
    }
  }
  return merged;
}

// ── R1: provider message observer ────────────────────────────────────────────

/**
 * Raw provider activity surfaced to observers. `tool_use` fires from the
 * provider's pre-tool hook with the tool's name and (unredacted, in-container)
 * input — observers that forward anything host-ward rely on the host-side
 * redaction pass, same as today's status feed. `batch_start` fires when a
 * message batch is accepted for processing (before command handling);
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

// ── R3: provider exchange observer ───────────────────────────────────────────

/**
 * Fires once per completed exchange — a prompt and the result text that
 * answered it, with the continuation as of that result. Notified alongside
 * the provider's own onExchangeComplete hook; observers run FIRST, so a
 * throwing provider hook can never cost a module its record of the exchange.
 */
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

// ── test support ──────────────────────────────────────────────────────────────

/**
 * Snapshot the registries and return a restore function. bun runs every test
 * file in ONE process, so a test must never wipe registrations other modules
 * made at import time (status feed, learning loop) — it snapshots, registers
 * its own hooks, and restores. Not for runtime use.
 */
export function __snapshotProviderHooksForTest(): () => void {
  const contributors = [...queryOptionsContributors];
  const observers = [...messageObservers];
  const exchange = [...exchangeObservers];
  return () => {
    queryOptionsContributors.length = 0;
    queryOptionsContributors.push(...contributors);
    messageObservers.length = 0;
    messageObservers.push(...observers);
    exchangeObservers.length = 0;
    exchangeObservers.push(...exchange);
  };
}
