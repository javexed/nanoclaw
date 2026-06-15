/**
 * Tests for surfacing agent↔agent (a2a) messages into a shared webchat room.
 *
 * When two agents are both wired to the same webchat room, an a2a message
 * between them is copied into that room as a read-only side-channel entry
 * (message_type/sender_type='a2a', content={to,text}) so humans can watch the
 * exchange. Surfacing is skipped when the agents share no room, for
 * self-messages, and for empty text.
 */
import { randomUUID } from 'crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { surfaceA2aMessage } from './state.js';
import { getSharedWebchatRooms } from './db.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
}));

const now = () => new Date().toISOString();

function wire(roomId: string, agentId: string) {
  createMessagingGroupAgent({
    id: randomUUID(),
    messaging_group_id: roomId,
    agent_group_id: agentId,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
}

function a2aRows(roomId: string) {
  return getDb().prepare(`SELECT * FROM webchat_messages WHERE room_id = ? AND message_type = 'a2a'`).all(roomId) as {
    sender: string;
    sender_type: string;
    content: string;
  }[];
}

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());

  createAgentGroup({ id: 'ag-green', name: 'greensight', folder: 'green', agent_provider: null, created_at: now() });
  createAgentGroup({ id: 'ag-rev', name: 'Code Reviewer', folder: 'rev', agent_provider: null, created_at: now() });
  createAgentGroup({ id: 'ag-lonely', name: 'Lonely', folder: 'lonely', agent_provider: null, created_at: now() });

  // Shared room: greensight + Code Reviewer both wired.
  createMessagingGroup({
    id: 'mg-shared',
    channel_type: 'webchat',
    platform_id: 'plant-vision',
    name: 'Plant Vision',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  wire('mg-shared', 'ag-green');
  wire('mg-shared', 'ag-rev');

  // A room only greensight is in (Lonely is not co-resident anywhere with green).
  createMessagingGroup({
    id: 'mg-solo',
    channel_type: 'webchat',
    platform_id: 'solo',
    name: 'Solo',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  wire('mg-solo', 'ag-green');
});

afterEach(() => {
  closeDb();
});

describe('getSharedWebchatRooms', () => {
  it('returns rooms both agents are wired to', () => {
    const rooms = getSharedWebchatRooms('ag-green', 'ag-rev');
    expect(rooms.map((r) => r.id)).toEqual(['plant-vision']);
  });

  it('returns nothing when the agents share no room', () => {
    expect(getSharedWebchatRooms('ag-green', 'ag-lonely')).toEqual([]);
  });
});

describe('surfaceA2aMessage', () => {
  it('writes an a2a-typed copy into the shared room with from/to attribution', () => {
    surfaceA2aMessage('ag-green', 'ag-rev', JSON.stringify({ text: 'can you check your status?' }));

    const rows = a2aRows('plant-vision');
    expect(rows).toHaveLength(1);
    expect(rows[0].sender).toBe('greensight');
    expect(rows[0].sender_type).toBe('a2a');
    const parsed = JSON.parse(rows[0].content);
    expect(parsed).toEqual({ to: 'Code Reviewer', text: 'can you check your status?' });
  });

  it('does not surface when the agents share no room', () => {
    surfaceA2aMessage('ag-green', 'ag-lonely', JSON.stringify({ text: 'hi' }));
    expect(a2aRows('solo')).toHaveLength(0);
  });

  it('skips self-messages (from === to)', () => {
    surfaceA2aMessage('ag-green', 'ag-green', JSON.stringify({ text: 'note to self' }));
    expect(a2aRows('plant-vision')).toHaveLength(0);
    expect(a2aRows('solo')).toHaveLength(0);
  });

  it('skips empty text', () => {
    surfaceA2aMessage('ag-green', 'ag-rev', JSON.stringify({ text: '   ' }));
    expect(a2aRows('plant-vision')).toHaveLength(0);
  });
});
