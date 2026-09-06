/**
 * Provider seam (hooks.ts) — the contracts every hookified touchpoint relies
 * on: inert-by-default, contribution merge order, throw isolation, and the
 * learning loop's registered contributor producing the exact options the
 * claude provider used to hardcode (the R2 extraction's regression guard).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import {
  __snapshotProviderHooksForTest,
  notifyProviderMessage,
  registerProviderMessageObserver,
  registerProviderQueryOptionsContributor,
  resolveProviderQueryOptions,
} from './hooks.js';
import type { QueryInput } from './types.js';

const baseInput: QueryInput = { prompt: 'hi', cwd: '/tmp', continuation: null } as unknown as QueryInput;

// Snapshot/restore instead of wiping: other modules (status feed, learning
// loop) register at import time in this same process, and later test files
// depend on those registrations surviving this one.
let restoreHooks: () => void;
beforeEach(() => {
  restoreHooks = __snapshotProviderHooksForTest();
});
afterEach(() => {
  restoreHooks();
});

describe('resolveProviderQueryOptions', () => {
  it('returns {} when nothing is registered (call-sites stay inert)', () => {
    expect(resolveProviderQueryOptions(baseInput)).toEqual({});
  });

  it('merges contributions in registration order, later wins per key', () => {
    registerProviderQueryOptionsContributor(() => ({ model: 'first', forkSession: true }));
    registerProviderQueryOptionsContributor(() => ({ model: 'second' }));
    expect(resolveProviderQueryOptions(baseInput)).toEqual({ model: 'second', forkSession: true });
  });

  it('an explicitly-undefined key does not clobber an earlier contribution', () => {
    registerProviderQueryOptionsContributor(() => ({ model: 'kept' }));
    registerProviderQueryOptionsContributor(() => ({ model: undefined, forkSession: true }));
    expect(resolveProviderQueryOptions(baseInput)).toEqual({ model: 'kept', forkSession: true });
  });

  it('a throwing contributor is skipped, others still apply', () => {
    registerProviderQueryOptionsContributor(() => {
      throw new Error('boom');
    });
    registerProviderQueryOptionsContributor(() => ({ allowedTools: ['x'] }));
    expect(resolveProviderQueryOptions(baseInput)).toEqual({ allowedTools: ['x'] });
  });
});

describe('notifyProviderMessage', () => {
  it('is a no-op with nothing registered', () => {
    expect(() => notifyProviderMessage({ kind: 'tool_use', toolName: 'Bash' })).not.toThrow();
  });

  it('fans out to every observer and isolates a throwing one', () => {
    const seen: string[] = [];
    registerProviderMessageObserver(() => {
      throw new Error('boom');
    });
    registerProviderMessageObserver((ev) => {
      if (ev.kind === 'tool_use') seen.push(ev.toolName);
    });
    notifyProviderMessage({ kind: 'tool_use', toolName: 'Read', toolInput: { file_path: '/a' } });
    expect(seen).toEqual(['Read']);
  });
});
