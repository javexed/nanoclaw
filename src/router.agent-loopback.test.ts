/**
 * Tests for agent-authored loop-back fan-out (Pattern C in the channel model).
 *
 * Webchat's `deliver()` re-enters the router with `senderAgentGroupId` set
 * so other agents wired to the same room can react to an agent's reply
 * ("@advisor what's your take?"). Without bounded engagement, that creates
 * loop hazards. This test file locks in the three guards:
 *
 *   1. Self-exclusion         — producing agent never re-engages itself
 *   2. Prime-skip             — `^(?!...)` catch-all wirings ignore agent posts
 *   3. (Rate limit lives in the webchat adapter — tested separately)
 */
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import { findSession } from './db/sessions.js';
import type { InboundEvent } from './channels/adapter.js';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-loopback' };
});

const TEST_DIR = '/tmp/nanoclaw-test-loopback';
const now = () => new Date().toISOString();

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  // Three-agent room mirroring the user's `floor` setup:
  //   News    — prime (negative-lookahead pattern, ignores @-mentions to others)
  //   FOMC    — \B@fomc\b
  //   Advisor — \B@advisor\b
  createAgentGroup({ id: 'ag-news', name: 'News', folder: 'news', agent_provider: null, created_at: now() });
  createAgentGroup({ id: 'ag-fomc', name: 'FOMC', folder: 'fomc', agent_provider: null, created_at: now() });
  createAgentGroup({ id: 'ag-advisor', name: 'Advisor', folder: 'advisor', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-floor',
    channel_type: 'webchat',
    platform_id: 'floor',
    name: 'floor',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  const wire = (id: string, agentGroupId: string, pattern: string) =>
    createMessagingGroupAgent({
      id,
      messaging_group_id: 'mg-floor',
      agent_group_id: agentGroupId,
      engage_mode: 'pattern',
      engage_pattern: pattern,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  wire('mga-news', 'ag-news', '^(?!.*\\B@([Ff][Oo][Mm][Cc]|[Aa][Dd][Vv][Ii][Ss][Oo][Rr])\\b)');
  wire('mga-fomc', 'ag-fomc', '\\B@[Ff][Oo][Mm][Cc]\\b');
  wire('mga-advisor', 'ag-advisor', '\\B@[Aa][Dd][Vv][Ii][Ss][Oo][Rr]\\b');
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

const baseEvent = (overrides: Partial<InboundEvent['message']> & { text: string }): InboundEvent => ({
  channelType: 'webchat',
  platformId: 'floor',
  threadId: null,
  message: {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    content: JSON.stringify({ sender: 'Test', text: overrides.text }),
    timestamp: now(),
    isMention: overrides.isMention,
    isGroup: true,
    senderAgentGroupId: overrides.senderAgentGroupId,
  },
});

describe('agent-authored loop-back', () => {
  it('human @-mention engages only the addressed agent (baseline)', async () => {
    const { routeInbound } = await import('./router.js');
    await routeInbound(baseEvent({ text: '@fomc what is next' }));
    expect(findSession('mg-floor', null)).toBeDefined();
    // News should NOT have a session — its negative-lookahead excludes messages mentioning @fomc.
    // Quick check via session table: only one session exists, and it's FOMC's.
    const { getActiveSessions } = await import('./db/sessions.js');
    const active = getActiveSessions();
    expect(active).toHaveLength(1);
    expect(active[0].agent_group_id).toBe('ag-fomc');
  });

  it('human message with no @-mention engages the prime (News) only', async () => {
    const { routeInbound } = await import('./router.js');
    await routeInbound(baseEvent({ text: 'general market chatter' }));
    const { getActiveSessions } = await import('./db/sessions.js');
    const active = getActiveSessions();
    expect(active).toHaveLength(1);
    expect(active[0].agent_group_id).toBe('ag-news');
  });

  it('agent loop-back: producer is self-excluded even when text matches own pattern', async () => {
    const { routeInbound } = await import('./router.js');
    // FOMC's reply happens to include "@fomc" (e.g. self-reference). The pattern
    // matches, but self-exclusion drops it — FOMC must not re-engage itself.
    await routeInbound(baseEvent({ text: '@fomc reporting — meeting Tuesday', senderAgentGroupId: 'ag-fomc' }));
    const { getActiveSessions } = await import('./db/sessions.js');
    expect(getActiveSessions()).toHaveLength(0);
  });

  it('agent loop-back: prime is skipped on unaddressed agent posts', async () => {
    const { routeInbound } = await import('./router.js');
    // Unaddressed text. For a human sender this would wake News (prime catch-all).
    // For an agent sender, the prime is skipped — no spontaneous chain reaction.
    await routeInbound(baseEvent({ text: 'FOMC meets Tuesday at 2pm', senderAgentGroupId: 'ag-fomc' }));
    const { getActiveSessions } = await import('./db/sessions.js');
    expect(getActiveSessions()).toHaveLength(0);
  });

  it('agent loop-back: explicit @-mention to another agent DOES engage', async () => {
    const { routeInbound } = await import('./router.js');
    // FOMC explicitly addresses Advisor — that's the entire point of Pattern C.
    await routeInbound(baseEvent({ text: '@advisor your view on the FOMC decision?', senderAgentGroupId: 'ag-fomc' }));
    const { getActiveSessions } = await import('./db/sessions.js');
    const active = getActiveSessions();
    expect(active).toHaveLength(1);
    expect(active[0].agent_group_id).toBe('ag-advisor');
  });

  it('agent loop-back: mentioning self + another agent engages only the other', async () => {
    const { routeInbound } = await import('./router.js');
    // FOMC writes "@fomc to @advisor". Self skipped; Advisor engages.
    await routeInbound(
      baseEvent({ text: '@fomc to @advisor — your read on this?', senderAgentGroupId: 'ag-fomc' }),
    );
    const { getActiveSessions } = await import('./db/sessions.js');
    const active = getActiveSessions();
    expect(active).toHaveLength(1);
    expect(active[0].agent_group_id).toBe('ag-advisor');
  });
});
