/**
 * Tests for the per-user room-pin helpers that back the sticky "pinned" group
 * at the top of the sidebar.
 *
 * Pins mirror the read-marker model: per-(user, room), keyed on the trusted
 * webchat user_id so a pin follows the user across devices. These tests pin the
 * server-side semantics:
 *
 *   - pin/unpin is per-user and idempotent.
 *   - getRoomLastActivity returns the newest message time per room (the Recent
 *     sort key), absent for empty rooms.
 *   - annotateRoomsForUser surfaces the per-user `pinned` flag and a
 *     `last_activity` value (message time, falling back to the room's created_at).
 *   - pins cascade away with the room (clearPinsForRoom / delete).
 */
import { randomUUID } from 'crypto';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { annotateRoomsForUser } from './state.js';
import {
  clearPinsForRoom,
  deleteWebchatRoom,
  getPinnedRoomIdsForUser,
  getRoomLastActivity,
  pinRoomForUser,
  unpinRoomForUser,
} from './db.js';

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});

afterEach(() => {
  closeDb();
});

// ── Seed helpers (mirrors reads.test.ts) ──

function insertRoom(roomId: string, name = roomId): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO messaging_groups (id, channel_type, instance, platform_id, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, 'webchat', 'webchat', ?, ?, 0, 'public', ?)`,
    )
    .run(roomId, roomId, name, new Date().toISOString());
}

function insertAgentGroup(id: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`,
    )
    .run(id, id, id, new Date().toISOString());
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

/** A room wired to an agent group so the owner can access it (mirrors reads.test). */
function accessibleRoom(roomId: string): void {
  insertAgentGroup(`ag-${roomId}`);
  insertRoom(roomId);
  wire(roomId, `ag-${roomId}`);
}

function grantOwner(userId: string): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'webchat', NULL, ?)`)
    .run(userId, new Date().toISOString());
  getDb()
    .prepare(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
       VALUES (?, 'owner', NULL, NULL, ?)`,
    )
    .run(userId, new Date().toISOString());
}

function insertMessage(roomId: string, createdAt: number): void {
  getDb()
    .prepare(
      `INSERT INTO webchat_messages (id, room_id, sender, content, created_at)
       VALUES (?, ?, 'someone', 'hi', ?)`,
    )
    .run(randomUUID(), roomId, createdAt);
}

describe('pin/unpin', () => {
  it('pins and unpins a room for one user', () => {
    expect(getPinnedRoomIdsForUser('webchat:alice').has('room-1')).toBe(false);
    pinRoomForUser('webchat:alice', 'room-1');
    expect(getPinnedRoomIdsForUser('webchat:alice').has('room-1')).toBe(true);
    unpinRoomForUser('webchat:alice', 'room-1');
    expect(getPinnedRoomIdsForUser('webchat:alice').has('room-1')).toBe(false);
  });

  it('is idempotent — re-pinning keeps a single row', () => {
    pinRoomForUser('webchat:alice', 'room-1', 1000);
    pinRoomForUser('webchat:alice', 'room-1', 2000);
    expect(getPinnedRoomIdsForUser('webchat:alice').has('room-1')).toBe(true);
    const count = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM webchat_room_pins WHERE user_id = ? AND room_id = ?`)
      .get('webchat:alice', 'room-1') as { n: number };
    expect(count.n).toBe(1);
  });

  it('is per-user — one user pinning does not pin for another', () => {
    pinRoomForUser('webchat:alice', 'room-1');
    expect(getPinnedRoomIdsForUser('webchat:alice').has('room-1')).toBe(true);
    expect(getPinnedRoomIdsForUser('webchat:bob').has('room-1')).toBe(false);
  });
});

describe('getRoomLastActivity', () => {
  it('returns the newest message time per room and omits empty rooms', () => {
    insertMessage('room-1', 1000);
    insertMessage('room-1', 3000); // newer wins
    insertMessage('room-2', 2000);
    const map = getRoomLastActivity();
    expect(map.get('room-1')).toBe(3000);
    expect(map.get('room-2')).toBe(2000);
    expect(map.has('room-empty')).toBe(false);
  });
});

describe('annotateRoomsForUser — pinned + last_activity', () => {
  it('surfaces the per-user pinned flag', () => {
    accessibleRoom('room-1');
    grantOwner('webchat:owner');
    pinRoomForUser('webchat:owner', 'room-1');

    const room = annotateRoomsForUser('webchat:owner').find((r) => r.id === 'room-1');
    expect(room?.pinned).toBe(true);

    // Not pinned for a different user.
    grantOwner('webchat:owner2');
    expect(annotateRoomsForUser('webchat:owner2').find((r) => r.id === 'room-1')?.pinned).toBe(false);
  });

  it('reports last_activity as the newest message time', () => {
    accessibleRoom('room-1');
    grantOwner('webchat:owner');
    insertMessage('room-1', 5000);

    const room = annotateRoomsForUser('webchat:owner').find((r) => r.id === 'room-1');
    expect(room?.last_activity).toBe(5000);
  });

  it('falls back to the room created_at when the room has no messages', () => {
    accessibleRoom('room-1');
    grantOwner('webchat:owner');

    const room = annotateRoomsForUser('webchat:owner').find((r) => r.id === 'room-1');
    expect(typeof room?.last_activity).toBe('number');
    expect(room?.last_activity).toBe(room?.created_at);
  });
});

describe('cascade', () => {
  it('clearPinsForRoom drops a room’s pins', () => {
    pinRoomForUser('webchat:alice', 'room-1');
    pinRoomForUser('webchat:bob', 'room-1');
    clearPinsForRoom('room-1');
    expect(getPinnedRoomIdsForUser('webchat:alice').has('room-1')).toBe(false);
    expect(getPinnedRoomIdsForUser('webchat:bob').has('room-1')).toBe(false);
  });

  it('deleteWebchatRoom clears pins for that room', () => {
    insertRoom('room-1');
    pinRoomForUser('webchat:alice', 'room-1');
    deleteWebchatRoom('room-1');
    expect(getPinnedRoomIdsForUser('webchat:alice').has('room-1')).toBe(false);
  });
});
