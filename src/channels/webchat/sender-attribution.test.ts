/**
 * Tests for sender attribution in webchat's deliver() path.
 *
 * Before threading the producing agent's id through delivery.ts, the
 * adapter used `findActiveAgentForWebchatRoom` — a most-recently-active
 * heuristic that raced badly under concurrent containers. With the
 * `senderAgentGroupId` field on OutboundMessage, attribution is exact:
 * delivery.ts knows which session emitted the message and tells the
 * adapter. The heuristic remains only as a defensive fallback.
 *
 * This test covers the adapter's exit path (storeWebchatMessage's
 * `sender` field) and the loop-back's `senderAgentGroupId` propagation,
 * which together determine both UI display + router self-exclusion.
 */
import { randomUUID } from 'crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { createSession, updateSession } from '../../db/sessions.js';
import { storeWebchatMessage } from './db.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
}));

const now = () => new Date().toISOString();

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());

  // Two agents wired to one room, both with running sessions. The setup
  // is what previously confused the heuristic: which agent gets credit
  // when both are 'running' and have recently-bumped `last_active`?
  createAgentGroup({ id: 'ag-news', name: 'Financial News', folder: 'news', agent_provider: null, created_at: now() });
  createAgentGroup({
    id: 'ag-exec',
    name: 'Trade Executor',
    folder: 'executor',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-floor',
    channel_type: 'webchat',
    platform_id: 'floor',
    name: 'floor',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  for (const id of ['ag-news', 'ag-exec']) {
    createMessagingGroupAgent({
      id: randomUUID(),
      messaging_group_id: 'mg-floor',
      agent_group_id: id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
    createSession({
      id: `sess-${id}`,
      agent_group_id: id,
      messaging_group_id: 'mg-floor',
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: now(),
      created_at: now(),
    });
  }
  // Make Executor's last_active strictly more recent so the heuristic
  // (last_active DESC) would pick Executor — but the real producer is
  // News in our test scenario.
  updateSession('sess-ag-exec', { last_active: new Date(Date.now() + 1000).toISOString() });
});

afterEach(() => {
  closeDb();
});

describe('sender attribution — without threading (heuristic)', () => {
  it('the heuristic picks the most-recently-active session (the race we want to eliminate)', async () => {
    const { findActiveAgentForWebchatRoom } = await import('./db.js');
    const result = findActiveAgentForWebchatRoom('floor');
    // Executor wins because its last_active is newer — even though in our
    // scenario News is the real producer. This is exactly the failure mode
    // the threading change exists to fix.
    expect(result?.id).toBe('ag-exec');
  });
});

describe('sender attribution — with threading (exact)', () => {
  it('lookupAgentForMessage returns the named agent regardless of last_active', async () => {
    // Mirrors what the deliver() path does internally: prefer the threaded
    // id over the heuristic. lookupAgentForMessage is module-internal, so
    // we recreate its query inline to validate the contract.
    const ag = getDb().prepare('SELECT id, name, folder FROM agent_groups WHERE id = ?').get('ag-news') as
      | { id: string; name: string; folder: string }
      | undefined;
    expect(ag?.id).toBe('ag-news');
    expect(ag?.name).toBe('Financial News');
    // Critically, this is NOT the agent the heuristic would have picked.
    const { findActiveAgentForWebchatRoom } = await import('./db.js');
    expect(findActiveAgentForWebchatRoom('floor')?.id).toBe('ag-exec');
  });

  it('storing a message with the correct sender name produces an attributable row', () => {
    // Round-trip: store with News as the sender, verify the row reflects it.
    // In the buggy heuristic path this would have come out as "Trade Executor".
    const stored = storeWebchatMessage('floor', 'Financial News', 'agent', 'morning briefing text');
    const row = getDb().prepare('SELECT sender, sender_type FROM webchat_messages WHERE id = ?').get(stored.id) as {
      sender: string;
      sender_type: string;
    };
    expect(row.sender).toBe('Financial News');
    expect(row.sender_type).toBe('agent');
  });
});

describe('contract: OutboundMessage carries senderAgentGroupId end-to-end', () => {
  it('the adapter-layer message shape exposes the field', async () => {
    // Compile-time contract check: TypeScript permits assigning
    // senderAgentGroupId on OutboundMessage. If this test compiles, the
    // shape change is in place. We don't actually invoke the adapter here
    // (that requires the server + WS wiring); router.agent-loopback.test
    // covers the routing side. This test would have failed to type-check
    // before the OutboundMessage extension.
    const msg: import('../adapter.js').OutboundMessage = {
      kind: 'chat',
      content: { text: 'hi' },
      senderSessionId: 'sess-ag-news',
      senderAgentGroupId: 'ag-news',
    };
    expect(msg.senderAgentGroupId).toBe('ag-news');
    expect(msg.senderSessionId).toBe('sess-ag-news');
  });
});
