import { describe, it, expect, afterEach } from 'vitest';

import {
  registerContainerEnvResolver,
  resolveContainerEnv,
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
