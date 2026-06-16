/**
 * Scroll-back pagination: getWebchatMessagesBeforeId returns the block of
 * messages immediately older than an anchor, oldest-to-newest, so the client
 * can prepend it. Complements getWebchatMessagesAfterId (catch-up).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { getWebchatMessagesBeforeId, getWebchatMessages } from './db.js';

// Insert with an explicit created_at so ordering is deterministic (storeWebchatMessage
// stamps Date.now(), which collides for rows created in the same millisecond).
function seed(roomId: string, id: string, createdAt: number) {
  getDb()
    .prepare(
      `INSERT INTO webchat_messages (id, room_id, sender, sender_type, content, message_type, file_meta, created_at)
       VALUES (?, ?, 'u', 'user', ?, 'text', NULL, ?)`,
    )
    .run(id, roomId, `msg-${id}`, createdAt);
}

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
  // 10 messages, created_at 1..10, ids m1..m10.
  for (let i = 1; i <= 10; i++) seed('room-1', `m${i}`, i);
  // Noise in another room — must never leak in.
  seed('room-2', 'x1', 5);
});
afterEach(() => closeDb());

describe('getWebchatMessagesBeforeId', () => {
  it('returns the messages immediately before the anchor, oldest-to-newest', () => {
    const page = getWebchatMessagesBeforeId('room-1', 'm6', 3);
    expect(page.map((m) => m.id)).toEqual(['m3', 'm4', 'm5']); // the 3 just before m6, ascending
  });

  it('is scoped to the room (no cross-room leakage)', () => {
    const page = getWebchatMessagesBeforeId('room-1', 'm6', 50);
    expect(page.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(page.some((m) => m.id === 'x1')).toBe(false);
  });

  it('returns empty at the start of history (anchor is the oldest)', () => {
    expect(getWebchatMessagesBeforeId('room-1', 'm1', 50)).toEqual([]);
  });

  it('returns empty for an unknown anchor id', () => {
    expect(getWebchatMessagesBeforeId('room-1', 'nope', 50)).toEqual([]);
  });

  it('paginates: chaining before_id walks backwards to the start', () => {
    // Start from the last-50 initial window's oldest, then page back.
    const newest = getWebchatMessages('room-1', 4); // m7..m10
    expect(newest.map((m) => m.id)).toEqual(['m7', 'm8', 'm9', 'm10']);
    const older1 = getWebchatMessagesBeforeId('room-1', 'm7', 4); // m3..m6
    expect(older1.map((m) => m.id)).toEqual(['m3', 'm4', 'm5', 'm6']);
    const older2 = getWebchatMessagesBeforeId('room-1', 'm3', 4); // m1..m2 (short → end)
    expect(older2.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(older2.length).toBeLessThan(4); // client treats a short page as "no more"
  });
});
