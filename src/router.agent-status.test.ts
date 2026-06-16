/**
 * Agent lifecycle status gate (src/router.ts).
 *
 * Only `active` agents engage/wake. `paused` (benched) and `archived` (retired)
 * keep their wiring but a message addressed to them must NOT create a session.
 * This locks that gate in place — regressing it would silently re-animate
 * benched/retired agents.
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
import { setAgentStatus } from './db/agent-groups.js';
import { getActiveSessions } from './db/sessions.js';
import type { InboundEvent } from './channels/adapter.js';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-agent-status' };
});

const TEST_DIR = '/tmp/nanoclaw-test-agent-status';
const now = () => new Date().toISOString();

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: 'ag-bot', name: 'Bot', folder: 'bot', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-room',
    channel_type: 'webchat',
    platform_id: 'room',
    name: 'room',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-bot',
    messaging_group_id: 'mg-room',
    agent_group_id: 'ag-bot',
    engage_mode: 'pattern',
    engage_pattern: '.', // engages on anything
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

const event = (text: string): InboundEvent => ({
  channelType: 'webchat',
  platformId: 'room',
  threadId: null,
  message: {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    content: JSON.stringify({ sender: 'Tester', text }),
    timestamp: now(),
    isGroup: true,
  },
});

describe('agent status gate', () => {
  it('active agent engages (baseline)', async () => {
    const { routeInbound } = await import('./router.js');
    await routeInbound(event('hello'));
    const active = getActiveSessions();
    expect(active).toHaveLength(1);
    expect(active[0].agent_group_id).toBe('ag-bot');
  });

  it('paused agent does NOT engage', async () => {
    setAgentStatus('ag-bot', 'paused');
    const { routeInbound } = await import('./router.js');
    await routeInbound(event('hello'));
    expect(getActiveSessions()).toHaveLength(0);
  });

  it('archived agent does NOT engage', async () => {
    setAgentStatus('ag-bot', 'archived');
    const { routeInbound } = await import('./router.js');
    await routeInbound(event('hello'));
    expect(getActiveSessions()).toHaveLength(0);
  });

  it('re-activating a paused agent restores engagement', async () => {
    setAgentStatus('ag-bot', 'paused');
    setAgentStatus('ag-bot', 'active');
    const { routeInbound } = await import('./router.js');
    await routeInbound(event('hello'));
    expect(getActiveSessions()).toHaveLength(1);
  });
});
