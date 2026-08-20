import { afterEach, describe, expect, it } from 'vitest';

import {
  __resetNetworkPolicyResolversForTest,
  dockerNetworkArgs,
  registerNetworkPolicyResolver,
  resolveNetworkPolicy,
} from './index.js';
import { fixtureSpec } from './spec-fixture.js';

// The seam exists so an installed module can express a network topology that
// `spec.network` deliberately cannot ('shared-private' | 'none' only) — this
// install's per-group host-only egress being the case that forced it.

afterEach(() => __resetNetworkPolicyResolversForTest());

describe('network policy seam', () => {
  it('has no opinion when nothing is registered — core behavior is unchanged', () => {
    expect(resolveNetworkPolicy(fixtureSpec())).toBeNull();
  });

  it('returns the first resolver that claims the session', () => {
    registerNetworkPolicyResolver(() => null);
    registerNetworkPolicyResolver(() => ['--network', 'nc-host-only']);
    registerNetworkPolicyResolver(() => ['--network', 'never-reached']);
    expect(resolveNetworkPolicy(fixtureSpec())).toEqual(['--network', 'nc-host-only']);
  });

  it('distinguishes "no flags" from "no opinion"', () => {
    // [] is a decision — this session gets no network flags. null is abstention.
    // Collapsing them would make an explicit "leave it alone" fall through to
    // the lockdown rules, which is the opposite of what the module asked for.
    registerNetworkPolicyResolver(() => []);
    registerNetworkPolicyResolver(() => ['--network', 'must-not-win']);
    expect(resolveNetworkPolicy(fixtureSpec())).toEqual([]);
  });

  it('survives a throwing resolver rather than spawning on the wrong network', () => {
    // A resolver that throws must not be able to decide the network by accident.
    // Falling through to the built-in rules is the safe direction: those are the
    // ones that arm the lockdown.
    registerNetworkPolicyResolver(() => {
      throw new Error('module bug');
    });
    registerNetworkPolicyResolver(() => ['--network', 'nc-host-only']);
    expect(resolveNetworkPolicy(fixtureSpec())).toEqual(['--network', 'nc-host-only']);
  });

  it('sees the spec, so a resolver can decide per session', () => {
    const seen: string[] = [];
    registerNetworkPolicyResolver((spec) => {
      seen.push(spec.key.agentGroupId);
      return null;
    });
    resolveNetworkPolicy(fixtureSpec());
    expect(seen).toHaveLength(1);
  });
});

describe('dockerNetworkArgs rule order', () => {
  it("honours spec.network 'none' — the field was declared and never read", () => {
    // This is the bug the seam work surfaced: the doc comment on
    // dockerNetworkArgs claimed "`spec.network` states the intent, this
    // realizes it", and the function never looked at the field. A session
    // composed with no network quietly got the default one instead.
    expect(dockerNetworkArgs(fixtureSpec({ network: 'none' }))).toEqual(['--network', 'none']);
  });

  it('lets a module resolver outrank the declared intent', () => {
    // The resolver runs FIRST on purpose: a module that knows this install
    // supports host-only egress is strictly better informed than a two-value
    // field, and 'shared-private' is the value it needs to override.
    registerNetworkPolicyResolver(() => ['--network', 'nc-host-only']);
    expect(dockerNetworkArgs(fixtureSpec({ network: 'none' }))).toEqual(['--network', 'nc-host-only']);
  });
});
