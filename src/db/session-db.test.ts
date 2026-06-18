/**
 * Tests for core per-session messages_in schema maintenance.
 *
 * Task-specific DB tests (insertTask, cancel/pause/resume, updateTask,
 * insertRecurrence) live in `src/modules/scheduling/db.test.ts` with the
 * rest of the scheduling module.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';

import {
  getInboundSourceSessionId,
  getMaxStatusEventSeq,
  getStatusEventsSince,
  migrateMessagesInTable,
} from './session-db.js';

const TEST_DIR = '/tmp/nanoclaw-session-db-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('migrateMessagesInTable', () => {
  it('backfills series_id = id on legacy rows and is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Build a legacy inbound.db WITHOUT series_id to simulate a pre-fix install.
    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'task', datetime('now'), 'pending', '{}')",
    ).run('legacy-1', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const row = db.prepare('SELECT series_id FROM messages_in WHERE id = ?').get('legacy-1') as {
      series_id: string;
    };
    expect(row.series_id).toBe('legacy-1');
    db.close();
  });

  it('adds source_session_id on a legacy DB, leaves existing rows NULL, is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'chat', datetime('now'), 'pending', '{}')",
    ).run('legacy-2', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const cols = (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('source_session_id');

    expect(getInboundSourceSessionId(db, 'legacy-2')).toBeNull();
    expect(getInboundSourceSessionId(db, 'does-not-exist')).toBeNull();
    db.close();
  });
});

describe('status_events readers (webchat thinking bubble)', () => {
  const OUT_PATH = path.join(TEST_DIR, 'outbound.db');

  function freshOutbound(): Database.Database {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = new Database(OUT_PATH);
    db.exec(`
      CREATE TABLE status_events (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        kind       TEXT NOT NULL,
        text       TEXT,
        detail     TEXT,
        created_at TEXT NOT NULL
      );
    `);
    return db;
  }

  function append(db: Database.Database, kind: string, text: string | null, detail: string | null = null): void {
    db.prepare('INSERT INTO status_events (kind, text, detail, created_at) VALUES (?, ?, ?, ?)').run(
      kind,
      text,
      detail,
      new Date().toISOString(),
    );
  }

  it('getStatusEventsSince returns only rows past the watermark, in order', () => {
    const db = freshOutbound();
    append(db, 'tool', 'Read', 'a.ts');
    append(db, 'progress', 'Building');
    append(db, 'done', null);

    const all = getStatusEventsSince(db, 0);
    expect(all.map((e) => e.kind)).toEqual(['tool', 'progress', 'done']);
    expect(all[0]).toMatchObject({ kind: 'tool', text: 'Read', detail: 'a.ts' });

    // Past the first row's seq → only the later two.
    const after = getStatusEventsSince(db, all[0].seq);
    expect(after.map((e) => e.kind)).toEqual(['progress', 'done']);
    db.close();
  });

  it('getMaxStatusEventSeq tracks the latest seq across a clear', () => {
    const db = freshOutbound();
    expect(getMaxStatusEventSeq(db)).toBe(0);
    append(db, 'tool', 'Bash', 'ls');
    append(db, 'tool', 'Read', 'b.ts');
    const max = getMaxStatusEventSeq(db);
    expect(max).toBe(2);

    // Per-turn clear: rows gone, but AUTOINCREMENT keeps seq climbing.
    db.prepare('DELETE FROM status_events').run();
    expect(getMaxStatusEventSeq(db)).toBe(0); // empty table
    append(db, 'progress', 'Next turn');
    // New row's seq is higher than the pre-clear max → host watermark (= old max) sees it.
    const newRows = getStatusEventsSince(db, max);
    expect(newRows.map((e) => e.text)).toEqual(['Next turn']);
    db.close();
  });

  it('readers tolerate a missing status_events table (older session DB)', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = new Database(OUT_PATH);
    db.exec('CREATE TABLE messages_out (id TEXT PRIMARY KEY)'); // no status_events
    expect(getStatusEventsSince(db, 0)).toEqual([]);
    expect(getMaxStatusEventSeq(db)).toBe(0);
    db.close();
  });
});
