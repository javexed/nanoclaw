/**
 * Tests for the @-mention user-handle layer.
 *
 * Handles are the slug others type to @-mention a person (distinct from wiring
 * an agent — a user mention only notifies/surfaces, it never triggers an agent).
 * These tests pin:
 *   - slugifyHandle: the default-handle shape (lowercase, [a-z0-9-], capped).
 *   - ensureWebchatUserHandle: default-on-connect + collision suffixing, idempotent.
 *   - setWebchatUserHandle: validation (invalid shape) + uniqueness (taken).
 *   - resolveHandlesToUserIds / userIdForHandle: handle → user_id resolution.
 *   - extractHandles: which @tokens count as a mention (and that emails don't).
 *   - getMentionedRoomIdsForUser + annotateRoomsForUser.mention: the durable
 *     per-room mention badge, strictly-newer-than-read and per-user.
 */
import { randomUUID } from 'crypto';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { annotateRoomsForUser, extractHandles } from './state.js';
import {
  slugifyHandle,
  getWebchatUserHandle,
  userIdForHandle,
  setWebchatUserHandle,
  ensureWebchatUserHandle,
  resolveHandlesToUserIds,
  getMentionedRoomIdsForUser,
  markRoomRead,
} from './db.js';

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});

afterEach(() => {
  closeDb();
});

// ── Seed helpers (mirror reads.test.ts) ──

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
      `INSERT OR IGNORE INTO messaging_groups (id, channel_type, instance, platform_id, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, 'webchat', 'webchat', ?, ?, 0, 'public', ?)`,
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

function grantOwner(userId: string): void {
  insertUser(userId);
  getDb()
    .prepare(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
       VALUES (?, 'owner', NULL, NULL, ?)`,
    )
    .run(userId, new Date().toISOString());
}

function insertMessage(roomId: string, content: string, createdAt: number): void {
  getDb()
    .prepare(
      `INSERT INTO webchat_messages (id, room_id, sender, content, created_at)
       VALUES (?, ?, 'someone', ?, ?)`,
    )
    .run(randomUUID(), roomId, content, createdAt);
}

describe('slugifyHandle', () => {
  it('lowercases and replaces non-alphanumerics with hyphens', () => {
    expect(slugifyHandle('Jane Doe')).toBe('jane-doe');
    expect(slugifyHandle('jane.doe@example.com')).toBe('jane-doe-example-com');
  });

  it('trims leading/trailing hyphens and collapses runs', () => {
    expect(slugifyHandle('  !!Bob!!  ')).toBe('bob');
    expect(slugifyHandle('a___b')).toBe('a-b');
  });

  it('caps at 32 chars', () => {
    expect(slugifyHandle('x'.repeat(50)).length).toBe(32);
  });

  it('falls back to "user" when nothing usable remains', () => {
    expect(slugifyHandle('')).toBe('user');
    expect(slugifyHandle('???')).toBe('user');
  });
});

describe('ensureWebchatUserHandle', () => {
  it('defaults to a slug of the display name', () => {
    expect(ensureWebchatUserHandle('webchat:u1', 'Jane Doe')).toBe('jane-doe');
    expect(getWebchatUserHandle('webchat:u1')).toBe('jane-doe');
  });

  it('is idempotent — a second call keeps the first handle', () => {
    ensureWebchatUserHandle('webchat:u1', 'Jane Doe');
    setWebchatUserHandle('webchat:u1', 'jd'); // user later renames
    // ensure must NOT clobber the chosen handle back to the slug
    expect(ensureWebchatUserHandle('webchat:u1', 'Jane Doe')).toBe('jd');
  });

  it('suffixes on collision so each handle resolves to one user', () => {
    expect(ensureWebchatUserHandle('webchat:a', 'Sam')).toBe('sam');
    expect(ensureWebchatUserHandle('webchat:b', 'Sam')).toBe('sam-2');
    expect(ensureWebchatUserHandle('webchat:c', 'Sam')).toBe('sam-3');
  });
});

describe('setWebchatUserHandle', () => {
  it('sets a valid handle and normalizes case', () => {
    expect(setWebchatUserHandle('webchat:u1', 'Alice')).toEqual({ ok: true });
    expect(getWebchatUserHandle('webchat:u1')).toBe('alice');
  });

  it('rejects an invalid shape', () => {
    expect(setWebchatUserHandle('webchat:u1', 'has spaces')).toEqual({ ok: false, reason: 'invalid' });
    expect(setWebchatUserHandle('webchat:u1', 'no_underscores')).toEqual({ ok: false, reason: 'invalid' });
    expect(setWebchatUserHandle('webchat:u1', '')).toEqual({ ok: false, reason: 'invalid' });
    expect(setWebchatUserHandle('webchat:u1', 'x'.repeat(33))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a handle already taken by another user', () => {
    setWebchatUserHandle('webchat:u1', 'taken');
    expect(setWebchatUserHandle('webchat:u2', 'taken')).toEqual({ ok: false, reason: 'taken' });
    expect(setWebchatUserHandle('webchat:u2', 'TAKEN')).toEqual({ ok: false, reason: 'taken' });
  });

  it('lets the same user re-set their own handle (no false "taken")', () => {
    setWebchatUserHandle('webchat:u1', 'alice');
    expect(setWebchatUserHandle('webchat:u1', 'alice')).toEqual({ ok: true });
    expect(setWebchatUserHandle('webchat:u1', 'alice2')).toEqual({ ok: true });
    expect(getWebchatUserHandle('webchat:u1')).toBe('alice2');
  });
});

describe('userIdForHandle / resolveHandlesToUserIds', () => {
  it('resolves a handle to its owning user id', () => {
    setWebchatUserHandle('webchat:u1', 'alice');
    expect(userIdForHandle('alice')).toBe('webchat:u1');
    expect(userIdForHandle('ALICE')).toBe('webchat:u1'); // case-insensitive
    expect(userIdForHandle('nobody')).toBeNull();
  });

  it('maps a set of handles to user ids, dedups, and drops unknowns', () => {
    setWebchatUserHandle('webchat:u1', 'alice');
    setWebchatUserHandle('webchat:u2', 'bob');
    const ids = resolveHandlesToUserIds(['alice', 'BOB', 'alice', 'ghost']);
    expect(ids.sort()).toEqual(['webchat:u1', 'webchat:u2']);
  });

  it('returns nothing for an empty list', () => {
    expect(resolveHandlesToUserIds([])).toEqual([]);
  });
});

describe('extractHandles', () => {
  it('pulls @tokens, lowercased', () => {
    expect(extractHandles('hey @Alice and @bob-2')).toEqual(['alice', 'bob-2']);
  });

  it('matches at start of string', () => {
    expect(extractHandles('@alice hi')).toEqual(['alice']);
  });

  it('does NOT treat an email as a mention (no word boundary before @)', () => {
    expect(extractHandles('mail me at foo@example.com')).toEqual([]);
  });

  it('returns nothing when there is no mention', () => {
    expect(extractHandles('just a normal message')).toEqual([]);
  });
});

describe('getMentionedRoomIdsForUser', () => {
  it('flags a room whose unread message @-mentions the handle', () => {
    setWebchatUserHandle('webchat:alice', 'alice');
    insertMessage('room-1', 'hey @alice look at this', 1000);
    expect(getMentionedRoomIdsForUser('webchat:alice', 'alice').has('room-1')).toBe(true);
  });

  it('clears once the room is read past the mention', () => {
    setWebchatUserHandle('webchat:alice', 'alice');
    insertMessage('room-1', 'hey @alice', 1000);
    markRoomRead('webchat:alice', 'room-1', 1000);
    expect(getMentionedRoomIdsForUser('webchat:alice', 'alice').has('room-1')).toBe(false);
  });

  it('re-flags when a newer mention arrives after reading', () => {
    setWebchatUserHandle('webchat:alice', 'alice');
    insertMessage('room-1', 'hey @alice', 1000);
    markRoomRead('webchat:alice', 'room-1', 1000);
    insertMessage('room-1', '@alice again', 2000);
    expect(getMentionedRoomIdsForUser('webchat:alice', 'alice').has('room-1')).toBe(true);
  });

  it('ignores rooms that mention someone else', () => {
    insertMessage('room-1', 'hey @bob', 1000);
    expect(getMentionedRoomIdsForUser('webchat:alice', 'alice').has('room-1')).toBe(false);
  });

  it('is empty for a blank handle', () => {
    insertMessage('room-1', 'hey @alice', 1000);
    expect(getMentionedRoomIdsForUser('webchat:alice', '').size).toBe(0);
  });
});

describe('annotateRoomsForUser — mention flag', () => {
  it('sets mention:true for an accessible room with an unread @-mention', () => {
    grantOwner('webchat:owner');
    setWebchatUserHandle('webchat:owner', 'owner');
    insertAgentGroup('ag-1');
    insertRoom('room-1');
    wire('room-1', 'ag-1');
    insertMessage('room-1', 'ping @owner', 1000);

    const room = annotateRoomsForUser('webchat:owner').find((r) => r.id === 'room-1');
    expect(room?.mention).toBe(true);
    expect(room?.unread).toBe(true);
  });

  it('clears the mention flag once the room is read', () => {
    grantOwner('webchat:owner');
    setWebchatUserHandle('webchat:owner', 'owner');
    insertAgentGroup('ag-1');
    insertRoom('room-1');
    wire('room-1', 'ag-1');
    insertMessage('room-1', 'ping @owner', 1000);
    markRoomRead('webchat:owner', 'room-1', 1000);

    const room = annotateRoomsForUser('webchat:owner').find((r) => r.id === 'room-1');
    expect(room?.mention).toBe(false);
  });

  it('does not flag a plain unread room (no mention) as mention', () => {
    grantOwner('webchat:owner');
    setWebchatUserHandle('webchat:owner', 'owner');
    insertAgentGroup('ag-1');
    insertRoom('room-1');
    wire('room-1', 'ag-1');
    insertMessage('room-1', 'just a normal message', 1000);

    const room = annotateRoomsForUser('webchat:owner').find((r) => r.id === 'room-1');
    expect(room?.unread).toBe(true);
    expect(room?.mention).toBe(false);
  });
});
