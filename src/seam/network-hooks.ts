// Decide the network for one session, when the topology is richer than
// `spec.network` can say.
//
// `spec.network` is deliberately a two-value field ('shared-private' | 'none')
// because a SPEC should describe intent, not a runtime's vocabulary. An
// installed module may need a third thing this install actually supports —
// per-group host-only egress, where the container reaches the host gateway but
// nothing beyond it. Rather than widen the spec for every runtime's private
// vocabulary, a resolver returns the argv for the cases it recognizes and null
// for everything else, which falls through to the driver's built-in rules.
//
// Returning `[]` is meaningful and distinct from null: it means "this session
// gets no network flags at all", which is not the same as "I have no opinion".
//
// Core registers none: with nothing installed, every resolver is absent and the
// driver's behavior is exactly upstream's.
import { log } from '../log.js';
import type { SessionSpec } from '../drivers/types.js';

export type NetworkPolicyResolver = (spec: SessionSpec) => string[] | null;
const networkPolicyResolvers: NetworkPolicyResolver[] = [];
export function registerNetworkPolicyResolver(fn: NetworkPolicyResolver): void {
  networkPolicyResolvers.push(fn);
}
export function resolveNetworkPolicy(spec: SessionSpec): string[] | null {
  for (const fn of networkPolicyResolvers) {
    try {
      const out = fn(spec);
      if (out) return out;
    } catch (err) {
      // A resolver must never be able to spawn a container with the WRONG
      // network by throwing — fall through to the built-in rules, which are
      // the safe ones (lockdown when armed).
      log.warn('Network policy resolver failed; falling back', { err: String(err) });
    }
  }
  return null;
}

/** Test-only: drop registered resolvers so one test cannot leak into the next. */
export function __resetNetworkPolicyResolversForTest(): void {
  networkPolicyResolvers.length = 0;
}
