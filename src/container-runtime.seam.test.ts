import { describe, it, expect, afterEach } from 'vitest';

import {
  registerAgentIdentityResolver,
  registerContainerEnvResolver,
  resolveAgentIdentity,
  resolveContainerEnv,
  __snapshotAgentIdentityResolversForTest,
  __snapshotContainerEnvResolversForTest,
} from './container-runtime.js';

describe('container env resolvers (H2) — composition', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('defaults to {} with nothing registered', () => {
    restore = __snapshotContainerEnvResolversForTest();
    expect(resolveContainerEnv('ag-1', null)).toEqual({});
  });

  it('merges resolvers in registration order, later wins per key', () => {
    restore = __snapshotContainerEnvResolversForTest();
    registerContainerEnvResolver(() => ({ A: '1', B: 'first' }));
    registerContainerEnvResolver((agentGroupId, threadId) => ({ B: 'second', T: `${agentGroupId}:${threadId}` }));
    expect(resolveContainerEnv('ag-1', 'user-x')).toEqual({ A: '1', B: 'second', T: 'ag-1:user-x' });
  });

  it('a throwing resolver loses only its own contribution', () => {
    restore = __snapshotContainerEnvResolversForTest();
    registerContainerEnvResolver(() => ({ KEEP: 'yes' }));
    registerContainerEnvResolver(() => {
      throw new Error('resolver bug');
    });
    registerContainerEnvResolver(() => ({ AFTER: 'also-kept' }));
    expect(resolveContainerEnv('ag-1', null)).toEqual({ KEEP: 'yes', AFTER: 'also-kept' });
  });
});

describe('agent identity resolvers (H3) — first-non-null chain', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('defaults to null with nothing registered', () => {
    restore = __snapshotAgentIdentityResolversForTest();
    expect(resolveAgentIdentity('ag-1', null)).toBeNull();
  });

  it('first non-null claim wins; later resolvers are not consulted', () => {
    restore = __snapshotAgentIdentityResolversForTest();
    const calls: string[] = [];
    registerAgentIdentityResolver(() => {
      calls.push('a');
      return null; // no opinion
    });
    registerAgentIdentityResolver(() => {
      calls.push('b');
      return 'member-agent-b';
    });
    registerAgentIdentityResolver(() => {
      calls.push('c');
      return 'member-agent-c';
    });
    expect(resolveAgentIdentity('ag-1', 'user-x')).toBe('member-agent-b');
    expect(calls).toEqual(['a', 'b']);
  });

  it('a registering module can no longer un-register another (both are asked)', () => {
    restore = __snapshotAgentIdentityResolversForTest();
    registerAgentIdentityResolver((_, threadId) => (threadId === 'user-x' ? 'user-x-agent' : null));
    registerAgentIdentityResolver(() => null); // later module, no opinion
    expect(resolveAgentIdentity('ag-1', 'user-x')).toBe('user-x-agent');
  });

  it('skips throwing resolvers and malformed identifiers', () => {
    restore = __snapshotAgentIdentityResolversForTest();
    registerAgentIdentityResolver(() => {
      throw new Error('resolver bug');
    });
    registerAgentIdentityResolver(() => 'NOT/valid:ID');
    registerAgentIdentityResolver(() => 'valid-fallback-7');
    expect(resolveAgentIdentity('ag-1', null)).toBe('valid-fallback-7');
  });
});
