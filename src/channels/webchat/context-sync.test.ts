/**
 * Tests for the thread context-sync foundation: high-water marks, delta
 * selection (native-only, since-ts, fresh cap), and verbatim copy insertion.
 * See docs/webchat/webchat-thread-context-sync.md.
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
import { syncThreadContext } from './server.js';

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
      .prepare(
        `SELECT content, origin, message_type FROM webchat_messages WHERE room_id='r' AND thread_id='t1' ORDER BY created_at`,
      )
      .all() as { content: string; origin: string | null; message_type: string }[];
    expect(inThread.map((m) => m.content)).toEqual(['Pulled from main', 'one', 'two']);
    expect(inThread.every((m) => m.origin === 'pulled')).toBe(true);
    // Pulled copies are excluded from the thread's own delta (so push won't echo).
    expect(getSyncDelta('r', 't1', 0)).toEqual([]);
  });
});

function contentsInThread(room: string, thread: string): string[] {
  return (
    getDb()
      .prepare(`SELECT content FROM webchat_messages WHERE room_id=? AND thread_id=? ORDER BY created_at`)
      .all(room, thread) as { content: string }[]
  ).map((r) => r.content);
}

describe('thread context sync — pull (main → thread)', () => {
  it('fresh pull copies main, advances the mark, then no-ops with nothing new', () => {
    seed('r', 'main', 'a', 100);
    seed('r', 'main', 'b', 200);
    const first = syncThreadContext({
      roomId: 'r',
      srcThreadId: 'main',
      destThreadId: 't1',
      markThreadId: 't1',
      direction: 'pulled',
      dividerText: 'Pulled from regular chat',
      freshLimit: 50,
    });
    expect(first).toBe(2);
    expect(contentsInThread('r', 't1')).toEqual(['Pulled from regular chat', 'a', 'b']);
    expect(getThreadSyncMarks('r', 't1').pulled).toBe(200);
    // Nothing new in main → no-op.
    expect(
      syncThreadContext({
        roomId: 'r',
        srcThreadId: 'main',
        destThreadId: 't1',
        markThreadId: 't1',
        direction: 'pulled',
        dividerText: 'Pulled from regular chat',
      }),
    ).toBe(0);
    // A new main message → incremental pull brings only the delta.
    seed('r', 'main', 'c', 300);
    const second = syncThreadContext({
      roomId: 'r',
      srcThreadId: 'main',
      destThreadId: 't1',
      markThreadId: 't1',
      direction: 'pulled',
      dividerText: 'Pulled from regular chat',
    });
    expect(second).toBe(1);
    expect(contentsInThread('r', 't1')).toEqual([
      'Pulled from regular chat',
      'a',
      'b',
      'Pulled from regular chat',
      'c',
    ]);
  });

  it('fresh pull is bounded by freshLimit', () => {
    for (let i = 1; i <= 5; i++) seed('r', 'main', `m${i}`, i * 100);
    const copied = syncThreadContext({
      roomId: 'r',
      srcThreadId: 'main',
      destThreadId: 't1',
      markThreadId: 't1',
      direction: 'pulled',
      dividerText: 'Pulled from regular chat',
      freshLimit: 2,
    });
    expect(copied).toBe(2);
    expect(contentsInThread('r', 't1')).toEqual(['Pulled from regular chat', 'm4', 'm5']);
  });
});

describe('thread context sync — push (thread → main)', () => {
  it('pushes only the thread-native delta, never the pulled prefix', () => {
    // Thread t1 first pulls main context, then gains its own native messages.
    seed('r', 'main', 'mainA', 100);
    syncThreadContext({
      roomId: 'r',
      srcThreadId: 'main',
      destThreadId: 't1',
      markThreadId: 't1',
      direction: 'pulled',
      dividerText: 'Pulled from regular chat',
      freshLimit: 50,
    });
    seed('r', 't1', 'threadX', 300);
    seed('r', 't1', 'threadY', 400);

    const pushed = syncThreadContext({
      roomId: 'r',
      srcThreadId: 't1',
      destThreadId: 'main',
      markThreadId: 't1',
      direction: 'pushed',
      dividerText: 'Pushed from thread',
    });
    // Only the two native thread messages — the pulled copy of 'mainA' is skipped.
    expect(pushed).toBe(2);
    expect(contentsInThread('r', 'main')).toEqual(['mainA', 'Pushed from thread', 'threadX', 'threadY']);
    expect(getThreadSyncMarks('r', 't1').pushed).toBe(400);
  });

  it('multi-push carries only the new delta, never duplicating', () => {
    seed('r', 't1', 'one', 100);
    expect(
      syncThreadContext({
        roomId: 'r',
        srcThreadId: 't1',
        destThreadId: 'main',
        markThreadId: 't1',
        direction: 'pushed',
        dividerText: 'Pushed from thread',
        freshLimit: 50,
      }),
    ).toBe(1);
    // Second push with nothing new → no-op.
    expect(
      syncThreadContext({
        roomId: 'r',
        srcThreadId: 't1',
        destThreadId: 'main',
        markThreadId: 't1',
        direction: 'pushed',
        dividerText: 'Pushed from thread',
      }),
    ).toBe(0);
    // New thread message → third push carries just that one.
    seed('r', 't1', 'two', 200);
    expect(
      syncThreadContext({
        roomId: 'r',
        srcThreadId: 't1',
        destThreadId: 'main',
        markThreadId: 't1',
        direction: 'pushed',
        dividerText: 'Pushed from thread',
      }),
    ).toBe(1);
    expect(contentsInThread('r', 'main')).toEqual(['Pushed from thread', 'one', 'Pushed from thread', 'two']);
  });
});

describe('thread context sync — cascade', () => {
  it('deleteWebchatThread clears the thread sync marks', () => {
    setThreadSyncMark('r', 't1', 'pushed', 500);
    deleteWebchatThread('r', 't1');
    expect(getThreadSyncMarks('r', 't1')).toEqual({ pulled: 0, pushed: 0 });
  });
});
