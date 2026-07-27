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
