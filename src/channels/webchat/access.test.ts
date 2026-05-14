/**
 * Tests for per-room access control.
 *
 * These gate every read/write surface that exposes room contents — bugs
 * here let users see or send into rooms they don't have access to.
 */
import { randomUUID } from 'crypto';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { canAccessRoom, filterRoomsForUser } from './access.js';

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});

afterEach(() => {
  closeDb();
});

function insertUser(userId: string): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'webchat', NULL, ?)`)
    .run(userId, new Date().toISOString());
}

function insertAgentGroup(id: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`,
    )
    .run(id, id, id, new Date().toISOString());
}

function insertRoom(roomId: string, name = roomId): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, 'webchat', ?, ?, 0, 'public', ?)`,
    )
    .run(roomId, roomId, name, new Date().toISOString());
}

function wire(roomId: string, agentGroupId: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO messaging_group_agents
         (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern,
          sender_scope, ignored_message_policy, session_mode, priority, created_at)
       VALUES (?, ?, ?, 'pattern', '.', 'all', 'drop', 'shared', 0, ?)`,
    )
    .run(randomUUID(), roomId, agentGroupId, new Date().toISOString());
}

function grantRole(userId: string, role: 'owner' | 'admin' | 'member', agentGroupId: string | null): void {
  insertUser(userId);
  if (role === 'member') {
    if (!agentGroupId) throw new Error('member role requires agentGroupId');
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, NULL, ?)`,
      )
      .run(userId, agentGroupId, new Date().toISOString());
    return;
  }
  getDb()
    .prepare(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
       VALUES (?, ?, ?, NULL, ?)`,
    )
    .run(userId, role, agentGroupId, new Date().toISOString());
}

describe('canAccessRoom', () => {
  it('returns false for an unknown user', () => {
    insertAgentGroup('ag-1');
    insertRoom('room-1');
    wire('room-1', 'ag-1');
    expect(canAccessRoom('webchat:tailscale:nobody@example.com', 'room-1')).toBe(false);
  });

  it('returns false for a room with no wired agents', () => {
    grantRole('webchat:owner', 'owner', null);
    insertRoom('orphan-room');
    expect(canAccessRoom('webchat:owner', 'orphan-room')).toBe(false);
  });

  it('grants the global owner access to every room', () => {
    grantRole('webchat:owner', 'owner', null);
    insertAgentGroup('ag-1');
    insertRoom('room-1');
    wire('room-1', 'ag-1');
    expect(canAccessRoom('webchat:owner', 'room-1')).toBe(true);
  });

  it('grants a scoped admin access to rooms wired to their agent', () => {
    insertAgentGroup('ag-mine');
    insertAgentGroup('ag-other');
    insertRoom('room-mine');
    insertRoom('room-other');
    wire('room-mine', 'ag-mine');
    wire('room-other', 'ag-other');
    grantRole('webchat:admin', 'admin', 'ag-mine');
    expect(canAccessRoom('webchat:admin', 'room-mine')).toBe(true);
    expect(canAccessRoom('webchat:admin', 'room-other')).toBe(false);
  });

  it('grants a member access via agent_group_members', () => {
    insertAgentGroup('ag-1');
    insertRoom('room-1');
    wire('room-1', 'ag-1');
    grantRole('webchat:member', 'member', 'ag-1');
    expect(canAccessRoom('webchat:member', 'room-1')).toBe(true);
  });

  it('grants access to a multi-agent room if the user can reach any one agent', () => {
    insertAgentGroup('ag-mine');
    insertAgentGroup('ag-other');
    insertRoom('shared-room');
    wire('shared-room', 'ag-mine');
    wire('shared-room', 'ag-other');
    grantRole('webchat:admin', 'admin', 'ag-mine');
    expect(canAccessRoom('webchat:admin', 'shared-room')).toBe(true);
  });
});

describe('filterRoomsForUser', () => {
  it('only returns rooms the user can access', () => {
    insertAgentGroup('ag-mine');
    insertAgentGroup('ag-other');
    insertRoom('room-mine', 'Mine');
    insertRoom('room-other', 'Other');
    wire('room-mine', 'ag-mine');
    wire('room-other', 'ag-other');
    grantRole('webchat:admin', 'admin', 'ag-mine');

    const now = Date.now();
    const all = [
      { id: 'room-mine', name: 'Mine', created_at: now },
      { id: 'room-other', name: 'Other', created_at: now },
    ];
    expect(filterRoomsForUser('webchat:admin', all)).toEqual([{ id: 'room-mine', name: 'Mine', created_at: now }]);
  });
});
