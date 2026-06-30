/**
 * Tests for the thread context-sync foundation: high-water marks, delta
 * selection (native-only, since-ts, fresh cap), and verbatim copy insertion.
 * See docs/design/webchat-thread-context-sync.md.
 */
import { randomUUID } from 'crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import {
  getThreadSyncMarks,
  setThreadSyncMark,
  getSyncDelta,
  insertSyncedMessages,
  deleteWebchatThread,
} from './db.js';

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});
afterEach(() => closeDb());

function seed(room: string, thread: string, content: string, createdAt: number, origin: string | null = null): void {
  getDb()
    .prepare(
      `INSERT INTO webchat_messages (id, room_id, thread_id, sender, sender_type, content, message_type, file_meta, created_at, origin)
       VALUES (?, ?, ?, 'u', 'user', ?, 'text', NULL, ?, ?)`,
    )
    .run(randomUUID(), room, thread, content, createdAt, origin);
}

describe('thread context sync — marks', () => {
  it('default to 0 and advance monotonically', () => {
    expect(getThreadSyncMarks('r', 't')).toEqual({ pulled: 0, pushed: 0 });
    setThreadSyncMark('r', 't', 'pulled', 500);
    setThreadSyncMark('r', 't', 'pushed', 300);
    expect(getThreadSyncMarks('r', 't')).toEqual({ pulled: 500, pushed: 300 });
    // Monotonic — a lower value never moves the mark backwards.
    setThreadSyncMark('r', 't', 'pulled', 200);
    expect(getThreadSyncMarks('r', 't').pulled).toBe(500);
    setThreadSyncMark('r', 't', 'pulled', 900);
    expect(getThreadSyncMarks('r', 't').pulled).toBe(900);
  });
});

describe('thread context sync — getSyncDelta', () => {
  it('returns native messages after sinceTs, chronological', () => {
    seed('r', 'main', 'a', 100);
    seed('r', 'main', 'b', 200);
    seed('r', 'main', 'c', 300);
    expect(getSyncDelta('r', 'main', 0).map((m) => m.content)).toEqual(['a', 'b', 'c']);
    expect(getSyncDelta('r', 'main', 150).map((m) => m.content)).toEqual(['b', 'c']);
    expect(getSyncDelta('r', 'main', 300)).toEqual([]);
  });

  it('excludes copied (origin) rows and dividers', () => {
    seed('r', 't1', 'native', 100);
    seed('r', 't1', 'pulled-in', 200, 'pulled');
    getDb()
      .prepare(
        `INSERT INTO webchat_messages (id, room_id, thread_id, sender, sender_type, content, message_type, file_meta, created_at, origin)
         VALUES (?, 'r', 't1', 's', 'system', 'div', 'context-divider', NULL, 150, NULL)`,
      )
      .run(randomUUID());
    expect(getSyncDelta('r', 't1', 0).map((m) => m.content)).toEqual(['native']);
  });

  it('fresh cap (sinceTs=0) keeps only the last N, chronological', () => {
    for (let i = 1; i <= 5; i++) seed('r', 'main', `m${i}`, i * 100);
    expect(getSyncDelta('r', 'main', 0, 2).map((m) => m.content)).toEqual(['m4', 'm5']);
  });
});

describe('thread context sync — insertSyncedMessages', () => {
  it('appends a divider + verbatim copies, origin-marked, at the end', () => {
    seed('r', 'main', 'one', 100);
    seed('r', 'main', 'two', 200);
    const src = getSyncDelta('r', 'main', 0);
    const inserted = insertSyncedMessages('r', 't1', src, 'pulled', 'Pulled from main');
    expect(inserted[0].message_type).toBe('context-divider');
    expect(inserted.slice(1).map((m) => m.content)).toEqual(['one', 'two']);
    // Copies live in the destination thread, origin-marked; originals untouched.
    const inThread = getDb()
      .prepare(`SELECT content, origin, message_type FROM webchat_messages WHERE room_id='r' AND thread_id='t1' ORDER BY created_at`)
      .all() as { content: string; origin: string | null; message_type: string }[];
    expect(inThread.map((m) => m.content)).toEqual(['Pulled from main', 'one', 'two']);
    expect(inThread.every((m) => m.origin === 'pulled')).toBe(true);
    // Pulled copies are excluded from the thread's own delta (so push won't echo).
    expect(getSyncDelta('r', 't1', 0)).toEqual([]);
  });
});

describe('thread context sync — cascade', () => {
  it('deleteWebchatThread clears the thread sync marks', () => {
    setThreadSyncMark('r', 't1', 'pushed', 500);
    deleteWebchatThread('r', 't1');
    expect(getThreadSyncMarks('r', 't1')).toEqual({ pulled: 0, pushed: 0 });
  });
});
