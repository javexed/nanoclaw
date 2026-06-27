/**
 * Slice 0 — per-room threads storage layer: the migration (thread tables +
 * thread_id column), thread CRUD, thread-partitioned message read/write, and
 * per-thread read markers. See docs/design/webchat-threads.md §3,§9.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import {
  MAIN_THREAD,
  createWebchatRoom,
  deleteWebchatRoom,
  storeWebchatMessage,
  getWebchatMessages,
  ensureMainThread,
  ensureAgentThread,
  ensureThread,
  createWebchatThread,
  listWebchatThreads,
  getWebchatThread,
  renameWebchatThread,
  deleteWebchatThread,
  markThreadRead,
  getUnreadThreadIdsForRoom,
  threadToSessionKey,
  sessionKeyToThread,
} from './db.js';

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
  createWebchatRoom('Room', 'room-1');
});
afterEach(() => {
  closeDb();
});

describe('session-key mapping (slice 1)', () => {
  it("maps 'main'/absent to the legacy null session, named threads to themselves", () => {
    // main/absent → null: a thread-less room keeps its existing session
    expect(threadToSessionKey(MAIN_THREAD)).toBeNull();
    expect(threadToSessionKey(null)).toBeNull();
    expect(threadToSessionKey(undefined)).toBeNull();
    expect(threadToSessionKey('')).toBeNull();
    // named threads key their own session
    expect(threadToSessionKey('agent:sarah')).toBe('agent:sarah');
    expect(threadToSessionKey('u_abc')).toBe('u_abc');
  });
  it('inverse maps a session key back to the stored/UI thread', () => {
    expect(sessionKeyToThread(null)).toBe(MAIN_THREAD);
    expect(sessionKeyToThread(undefined)).toBe(MAIN_THREAD);
    expect(sessionKeyToThread('agent:sarah')).toBe('agent:sarah');
  });
  it('round-trips named threads', () => {
    for (const t of ['agent:max', 'u_xyz']) {
      expect(sessionKeyToThread(threadToSessionKey(t))).toBe(t);
    }
  });
});

describe('migration', () => {
  it('adds the thread tables + thread_id column (default main)', () => {
    // tables exist (helper calls don't throw)
    expect(() => listWebchatThreads('room-1')).not.toThrow();
    // a message stored without a thread lands in 'main' via the column default
    const m = storeWebchatMessage('room-1', 'Alice', 'user', 'hi');
    expect(m.thread_id).toBe('main');
    const col = (getDb().prepare("PRAGMA table_info('webchat_messages')").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(col).toContain('thread_id');
  });
});

describe('thread CRUD', () => {
  it('ensureThread is idempotent and does not clobber the title', () => {
    ensureMainThread('room-1');
    ensureThread('room-1', MAIN_THREAD, 'IGNORED', 'main'); // second ensure
    const main = getWebchatThread('room-1', MAIN_THREAD)!;
    expect(main.title).toBe('Main');
    expect(main.kind).toBe('main');
  });

  it('ensureAgentThread keys a deterministic per-agent lane', () => {
    const id = ensureAgentThread('room-1', 'sarah', 'Sarah');
    expect(id).toBe('agent:sarah');
    expect(ensureAgentThread('room-1', 'sarah', 'Sarah (again)')).toBe('agent:sarah'); // reused
    expect(getWebchatThread('room-1', 'agent:sarah')!.title).toBe('Sarah'); // not clobbered
  });

  it('createWebchatThread makes a uuid topic thread', () => {
    const t = createWebchatThread('room-1', 'Q3 planning');
    expect(t.kind).toBe('topic');
    expect(t.thread_id).not.toBe('main');
    expect(getWebchatThread('room-1', t.thread_id)!.title).toBe('Q3 planning');
  });

  it('lists threads with main first', () => {
    createWebchatThread('room-1', 'Topic A');
    ensureMainThread('room-1');
    ensureAgentThread('room-1', 'max', 'Max');
    const list = listWebchatThreads('room-1');
    expect(list[0].thread_id).toBe('main');
    expect(list.map((t) => t.kind)).toContain('agent');
    expect(list.map((t) => t.kind)).toContain('topic');
  });

  it('renames a thread', () => {
    const t = createWebchatThread('room-1', 'old');
    renameWebchatThread('room-1', t.thread_id, 'new');
    expect(getWebchatThread('room-1', t.thread_id)!.title).toBe('new');
  });
});

describe('thread-partitioned messages', () => {
  it('stores + reads history per thread', () => {
    storeWebchatMessage('room-1', 'Alice', 'user', 'in main'); // → main
    const t = createWebchatThread('room-1', 'Q3');
    storeWebchatMessage('room-1', 'Alice', 'user', 'in q3', t.thread_id);

    expect(getWebchatMessages('room-1', 200, MAIN_THREAD).map((m) => m.content)).toEqual(['in main']);
    expect(getWebchatMessages('room-1', 200, t.thread_id).map((m) => m.content)).toEqual(['in q3']);
    // no thread filter → all of the room's messages
    expect(getWebchatMessages('room-1').length).toBe(2);
  });
});

describe('per-thread read markers', () => {
  it('flags only threads with activity newer than the marker', () => {
    const t = createWebchatThread('room-1', 'Q3');
    storeWebchatMessage('room-1', 'Alice', 'user', 'a', MAIN_THREAD);
    storeWebchatMessage('room-1', 'Alice', 'user', 'b', t.thread_id);

    // nothing read yet → both unread
    expect(getUnreadThreadIdsForRoom('u1', 'room-1')).toEqual(new Set([MAIN_THREAD, t.thread_id]));

    markThreadRead('u1', 'room-1', MAIN_THREAD, Date.now() + 1000);
    expect(getUnreadThreadIdsForRoom('u1', 'room-1')).toEqual(new Set([t.thread_id]));
  });

  it('marker is monotonic (never moves backward)', () => {
    storeWebchatMessage('room-1', 'Alice', 'user', 'a', MAIN_THREAD);
    markThreadRead('u1', 'room-1', MAIN_THREAD, 5000);
    markThreadRead('u1', 'room-1', MAIN_THREAD, 1000); // older — ignored
    const row = getDb()
      .prepare(`SELECT last_read_at FROM webchat_thread_reads WHERE user_id=? AND room_id=? AND thread_id=?`)
      .get('u1', 'room-1', MAIN_THREAD) as { last_read_at: number };
    expect(row.last_read_at).toBe(5000);
  });
});

describe('deletion + cascade', () => {
  it('deleteWebchatThread removes its messages + reads; main is not deletable', () => {
    const t = createWebchatThread('room-1', 'Q3');
    storeWebchatMessage('room-1', 'Alice', 'user', 'x', t.thread_id);
    markThreadRead('u1', 'room-1', t.thread_id, Date.now());

    deleteWebchatThread('room-1', t.thread_id);
    expect(getWebchatThread('room-1', t.thread_id)).toBeUndefined();
    expect(getWebchatMessages('room-1', 200, t.thread_id)).toEqual([]);

    ensureMainThread('room-1');
    deleteWebchatThread('room-1', MAIN_THREAD); // no-op
    expect(getWebchatThread('room-1', MAIN_THREAD)).toBeDefined();
  });

  it('deleteWebchatRoom drops the room threads + thread reads', () => {
    ensureMainThread('room-1');
    createWebchatThread('room-1', 'Q3');
    markThreadRead('u1', 'room-1', MAIN_THREAD, Date.now());

    deleteWebchatRoom('room-1');
    expect(getDb().prepare(`SELECT COUNT(*) c FROM webchat_threads WHERE room_id='room-1'`).get()).toEqual({ c: 0 });
    expect(getDb().prepare(`SELECT COUNT(*) c FROM webchat_thread_reads WHERE room_id='room-1'`).get()).toEqual({
      c: 0,
    });
  });
});
