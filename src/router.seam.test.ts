/**
 * Routing seams — the module hooks that change routing outcomes:
 * the inbound delivery-plan resolver (per-agent wake/context/skip + hints),
 * sender self-exclusion for looped-back agent messages, the turn gate
 * (module veto), and the session-key override (per-member sessions).
 *
 * Everything here must be inert by default: the last test pins that a null
 * plan / null override / non-vetoing gate reproduce stock routing.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  initTestDb,
  closeDb,
  getDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import { inboundDbPath } from './session-manager.js';
import { findSession } from './db/sessions.js';
import type { InboundEvent } from './channels/adapter.js';

// Mock container runner to prevent actual Docker spawning
vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Override DATA_DIR for tests
vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-router-seam' };
});

function now() {
  return new Date().toISOString();
}

const TEST_DIR = '/tmp/nanoclaw-test-router-seam';

// Chain-era registries accumulate for the process lifetime (no unregister),
// so each hook gets ONE registration driven by these per-test knobs.
let planForTest: (() => import('./router.js').InboundDeliveryPlan | null) | null = null;
let keyOverrideForTest: ((agentGroupId: string) => import('./session-manager.js').SessionKeyOverride | null) | null =
  null;
let hooksRegistered = false;
async function registerTestHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  const router = await import('./router.js');
  const sm = await import('./session-manager.js');
  router.registerInboundDeliveryPlanResolver(() => (planForTest ? planForTest() : null));
  sm.registerSessionKeyResolver((_mg, agentGroupId) => (keyOverrideForTest ? keyOverrideForTest(agentGroupId) : null));
}

beforeEach(async () => {
  planForTest = null;
  keyOverrideForTest = null;
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);

  for (const [id, name] of [
    ['ag-a', 'Agent A'],
    ['ag-b', 'Agent B'],
    ['ag-c', 'Agent C'],
  ] as const) {
    createAgentGroup({ id, name, folder: id, agent_provider: null, created_at: now() });
  }
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'webchat',
    platform_id: 'room-1',
    name: 'Room',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  for (const [mgaId, agId] of [
    ['mga-a', 'ag-a'],
    ['mga-b', 'ag-b'],
    ['mga-c', 'ag-c'],
  ] as const) {
    createMessagingGroupAgent({
      id: mgaId,
      messaging_group_id: 'mg-1',
      agent_group_id: agId,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  }
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

function makeEvent(overrides: Partial<InboundEvent['message']> = {}): InboundEvent {
  return {
    channelType: 'webchat',
    platformId: 'room-1',
    threadId: null,
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      content: JSON.stringify({ sender: 'User', text: 'hello' }),
      timestamp: now(),
      ...overrides,
    },
  };
}

/** Read messages_in for the (mg-1, null) session of one agent group. */
async function rowsFor(agentGroupId: string): Promise<Array<{ content: string; trigger: number }>> {
  // Sessions are per (agent_group, mg, thread); find via the sessions table.
  // Central-DB reads are async since upstream's driver refactor; the SESSION db
  // below is still better-sqlite3 and stays synchronous.
  const session = (await getDb().get(
    `SELECT id FROM sessions WHERE agent_group_id = ? AND messaging_group_id = 'mg-1'`,
    agentGroupId,
  )) as { id: string } | undefined;
  if (!session) return [];
  const dbPath = inboundDbPath(agentGroupId, session.id);
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath);
  const rows = db.prepare('SELECT content, trigger FROM messages_in').all() as Array<{
    content: string;
    trigger: number;
  }>;
  db.close();
  return rows;
}

describe('inbound delivery plan', () => {
  it("applies 'expected'/'defer'/absent as wake/context/skip, with hints in content", async () => {
    const router = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    vi.mocked(wakeContainer).mockClear();

    await registerTestHooks();
    planForTest = () => ({
      participants: ['ag-a', 'ag-b'],
      perAgent: new Map([
        ['ag-a', 'expected'],
        ['ag-b', 'defer'],
      ]),
    });

    await router.routeInbound(makeEvent());

    // ag-a: woken, trigger=1, hints merged into content
    const aRows = await rowsFor('ag-a');
    expect(aRows).toHaveLength(1);
    expect(aRows[0].trigger).toBe(1);
    const aContent = JSON.parse(aRows[0].content);
    expect(aContent.responseExpectation).toBe('expected');
    expect(aContent.participants).toEqual(['ag-a', 'ag-b']);
    expect(aContent.text).toBe('hello'); // original fields preserved

    // ag-b: silent context, trigger=0
    const bRows = await rowsFor('ag-b');
    expect(bRows).toHaveLength(1);
    expect(bRows[0].trigger).toBe(0);
    expect(JSON.parse(bRows[0].content).responseExpectation).toBe('defer');

    // ag-c: absent from the plan → skipped entirely (no session, no rows)
    expect(await rowsFor('ag-c')).toHaveLength(0);

    // Exactly one wake (ag-a)
    expect(vi.mocked(wakeContainer)).toHaveBeenCalledTimes(1);
  });

  it('excludes the producing agent from its own looped-back message', async () => {
    const router = await import('./router.js');

    await registerTestHooks();
    planForTest = () => ({
      participants: ['ag-a', 'ag-b'],
      perAgent: new Map([
        ['ag-a', 'expected'], // even though the plan names it...
        ['ag-b', 'defer'],
      ]),
      isPeerReply: true,
    });

    // ...the event was AUTHORED by ag-a (loop-back), so ag-a must be skipped.
    await router.routeInbound(makeEvent({ senderAgentGroupId: 'ag-a' }));

    expect(await rowsFor('ag-a')).toHaveLength(0);
    const bRows = await rowsFor('ag-b');
    expect(bRows).toHaveLength(1);
    expect(JSON.parse(bRows[0].content).isPeerReply).toBe(true);
  });

  it('a throwing resolver falls back to stock wiring evaluation', async () => {
    const router = await import('./router.js');
    await registerTestHooks();
    planForTest = () => {
      throw new Error('resolver bug');
    };

    await router.routeInbound(makeEvent());

    // Stock catch-all patterns: every agent gets the message.
    expect(await rowsFor('ag-a')).toHaveLength(1);
    expect(await rowsFor('ag-b')).toHaveLength(1);
    expect(await rowsFor('ag-c')).toHaveLength(1);
  });
});

describe('turn gate + session-key override', () => {
  it('a veto drops the turn, records it, and creates no session', async () => {
    const router = await import('./router.js');
    const sm = await import('./session-manager.js');

    // Gate driven by a mutable flag — turnGates has no unregister by design
    // (module registries are process-lifetime), so this single registration
    // serves the whole file.
    sm.registerTurnGate((mg, agentGroupId) =>
      agentGroupId === 'ag-b' ? { reason: 'test-policy-requires-setup' } : null,
    );

    await registerTestHooks(); // stock routing: no plan, no override
    await router.routeInbound(makeEvent());

    // ag-b vetoed: no inbound rows; drop recorded with the module's reason.
    expect(await rowsFor('ag-b')).toHaveLength(0);
    const drops = await getDb().all(`SELECT reason FROM unregistered_senders WHERE agent_group_id = 'ag-b'`) as Array<{ reason: string }>;
    expect(drops).toHaveLength(1);
    expect(drops[0].reason).toBe('test-policy-requires-setup');

    // The others deliver normally.
    expect(await rowsFor('ag-a')).toHaveLength(1);
    expect(await rowsFor('ag-c')).toHaveLength(1);
  });

  it('a session-key override redirects the turn to a differently-keyed session', async () => {
    const router = await import('./router.js');
    const sm = await import('./session-manager.js');

    await registerTestHooks();
    keyOverrideForTest = (agentGroupId) =>
      agentGroupId === 'ag-c' ? { sessionMode: 'per-thread', threadId: 'member:alice' } : null;

    await router.routeInbound(makeEvent());

    const cSessions = await getDb().all(`SELECT thread_id FROM sessions WHERE agent_group_id = 'ag-c'`) as Array<{
      thread_id: string | null;
    }>;
    expect(cSessions).toHaveLength(1);
    expect(cSessions[0].thread_id).toBe('member:alice');

    // Un-overridden agents keep the stock null-thread session.
    const aSessions = await getDb().all(`SELECT thread_id FROM sessions WHERE agent_group_id = 'ag-a'`) as Array<{
      thread_id: string | null;
    }>;
    expect(aSessions).toHaveLength(1);
    expect(aSessions[0].thread_id).toBeNull();
  });
});
