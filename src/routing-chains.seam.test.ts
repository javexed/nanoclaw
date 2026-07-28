import { describe, it, expect } from 'vitest';

import {
  registerSessionKeyResolver,
  resolveSessionKeyOverride,
  registerSessionInboundWriter,
  runSessionInboundWriter,
  type SessionInboundWriterArgs,
} from './session-manager.js';
import { registerInboundDeliveryPlanResolver, resolveInboundDeliveryPlan } from './router.js';
import type { MessagingGroup } from './types.js';

// Vitest isolates module state per test FILE — registrations here can't leak
// into other suites, so no snapshot/restore dance is needed.

const mg = { id: 'mg-1', channel_type: 'webchat', platform_id: 'room-1', is_group: 1 };

describe('session-key resolvers — first-non-null chain + namespace guard', () => {
  it('asks resolvers in order; first non-null override wins; throw is skipped', () => {
    registerSessionKeyResolver(() => {
      throw new Error('resolver bug');
    });
    registerSessionKeyResolver(() => null);
    registerSessionKeyResolver((_m, _ag, userId) =>
      userId === 'webchat:alice' ? { sessionMode: 'per-thread' as const, threadId: 'webchat:alice' } : null,
    );
    registerSessionKeyResolver((_m, _ag, userId) =>
      userId === 'webchat:alice' ? { sessionMode: 'shared' as const, threadId: 'never-reached' } : null,
    );
    expect(resolveSessionKeyOverride(mg, 'ag-1', 'webchat:alice')).toEqual({
      sessionMode: 'per-thread',
      threadId: 'webchat:alice',
    });
  });

  it('passes the pre-override thread so a resolver can key by (user, thread)', () => {
    // Without this a resolver that re-keys by user collapses every thread in a
    // room into one session: the room's and a topic thread's messages share a
    // queue, and replies come back on the wrong thread.
    // Scoped to one user: resolvers accumulate for the whole FILE and the chain
    // is first-non-null, so a resolver that claims every user would hijack the
    // tests below it.
    const seen: (string | null | undefined)[] = [];
    registerSessionKeyResolver((_m, _ag, userId, threadId) => {
      if (userId !== 'webchat:threadkey') return null;
      seen.push(threadId);
      return { sessionMode: 'per-thread' as const, threadId: `${userId}::${threadId ?? 'main'}` };
    });
    expect(resolveSessionKeyOverride(mg, 'ag-t', 'webchat:threadkey', 'topic-1')).toEqual({
      sessionMode: 'per-thread',
      threadId: 'webchat:threadkey::topic-1',
    });
    expect(resolveSessionKeyOverride(mg, 'ag-t', 'webchat:threadkey', null)).toEqual({
      sessionMode: 'per-thread',
      threadId: 'webchat:threadkey::main',
    });
    expect(seen).toEqual(['topic-1', null]);
  });

  it('gives a resolver null (not undefined) when the caller omits the thread', () => {
    // Older callers pass three args; the resolver must still see a definite value.
    let got: unknown = 'unset';
    registerSessionKeyResolver((_m, _ag, userId, threadId) => {
      if (userId === 'webchat:omitted') got = threadId;
      return null;
    });
    resolveSessionKeyOverride(mg, 'ag-t', 'webchat:omitted');
    expect(got).toBeNull();
  });

  it('rejects an override into the reserved system:% namespace and falls through', () => {
    registerSessionKeyResolver((_m, _ag, userId) =>
      userId === 'webchat:bob' ? { sessionMode: 'per-thread' as const, threadId: 'system:tasks:hijack' } : null,
    );
    registerSessionKeyResolver((_m, _ag, userId) =>
      userId === 'webchat:bob' ? { sessionMode: 'per-thread' as const, threadId: 'webchat:bob' } : null,
    );
    expect(resolveSessionKeyOverride(mg, 'ag-2', 'webchat:bob')).toEqual({
      sessionMode: 'per-thread',
      threadId: 'webchat:bob',
    });
  });
});

describe('session inbound writers — first-true-claims chain', () => {
  const args: SessionInboundWriterArgs = {
    agentGroupId: 'ag-1',
    session: { id: 'sess-1' } as SessionInboundWriterArgs['session'],
    roomId: 'room-1',
    currentMessageId: 'm-1',
    deliveryAddr: { platformId: 'room-1', channelType: 'webchat', threadId: null },
  };

  it('first writer returning true claims; decliners and throwers fall through', () => {
    const calls: string[] = [];
    registerSessionInboundWriter(() => {
      calls.push('declines');
      return false;
    });
    registerSessionInboundWriter(() => {
      calls.push('throws');
      throw new Error('writer bug');
    });
    registerSessionInboundWriter(() => {
      calls.push('claims');
      return true;
    });
    registerSessionInboundWriter(() => {
      calls.push('never');
      return true;
    });
    expect(runSessionInboundWriter(args)).toBe(true);
    expect(calls).toEqual(['declines', 'throws', 'claims']);
  });
});

describe('inbound delivery-plan resolvers — first-non-null chain', () => {
  it('skips null and throwing resolvers; first plan wins', () => {
    registerInboundDeliveryPlanResolver(() => null);
    registerInboundDeliveryPlanResolver(() => {
      throw new Error('planner bug');
    });
    const plan = { participants: ['ag-a'], perAgent: new Map([['ag-a', 'expected' as const]]) };
    registerInboundDeliveryPlanResolver((m) => (m.id === 'mg-1' ? plan : null));
    expect(resolveInboundDeliveryPlan(mg as unknown as MessagingGroup, null, 'hello', undefined)).toBe(plan);
  });

  it('returns null when no resolver claims the event', () => {
    expect(
      resolveInboundDeliveryPlan(
        { ...mg, id: 'mg-unclaimed', platform_id: 'other' } as unknown as MessagingGroup,
        null,
        'hi',
        undefined,
      ),
    ).toBeNull();
  });
});
