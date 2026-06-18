/**
 * agent-status forwarding module.
 *
 * Covers the load-bearing behaviors of forwardSessionStatus: skip the backlog
 * on first sight (so a host restart can't replay a turn), forward only rows
 * past the watermark in order, advance the watermark, and stay silent when the
 * session has no messaging group or no adapter.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const OUT_DIR = '/tmp/nanoclaw-agent-status-test';
const OUT_PATH = path.join(OUT_DIR, 'outbound.db');

const mgRow = { id: 'mg-1', channel_type: 'webchat', platform_id: 'room-1', instance: 'webchat' };
let messagingGroup: typeof mgRow | undefined = mgRow;

vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroup: () => messagingGroup,
}));

vi.mock('../../session-manager.js', () => ({
  openOutboundDb: () => new Database(OUT_PATH, { readonly: true }),
}));

import { forwardSessionStatus, notifySessionStopped, setStatusAdapter, stopSessionStatus } from './index.js';

function seedDb(): void {
  if (fs.existsSync(OUT_DIR)) fs.rmSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
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
  db.close();
}

function append(kind: string, text: string | null, detail: string | null = null): void {
  const db = new Database(OUT_PATH);
  db.prepare('INSERT INTO status_events (kind, text, detail, created_at) VALUES (?, ?, ?, ?)').run(
    kind,
    text,
    detail,
    new Date().toISOString(),
  );
  db.close();
}

const session = { id: 'sess-1', agent_group_id: 'ag-1', messaging_group_id: 'mg-1' } as never;

interface Captured {
  channelType: string;
  platformId: string;
  status: { kind: string; text: string | null; detail: string | null };
}
let captured: Captured[];

function stubAdapter() {
  captured = [];
  setStatusAdapter({
    async sendStatus(channelType, platformId, _threadId, status) {
      captured.push({ channelType, platformId, status });
    },
  });
}

beforeEach(() => {
  messagingGroup = mgRow;
  seedDb();
  stubAdapter();
  stopSessionStatus('sess-1'); // reset watermark between tests
});

afterEach(() => {
  if (fs.existsSync(OUT_DIR)) fs.rmSync(OUT_DIR, { recursive: true });
});

describe('forwardSessionStatus', () => {
  it('skips the backlog on first sight, then forwards only new rows', async () => {
    append('tool', 'Read', 'a.ts'); // backlog before host first sees this session

    await forwardSessionStatus(session); // first sight → seed watermark, forward nothing
    expect(captured).toHaveLength(0);

    append('progress', 'Building');
    append('done', null);
    await forwardSessionStatus(session);

    expect(captured.map((c) => c.status.kind)).toEqual(['progress', 'done']);
    expect(captured[0]).toMatchObject({ channelType: 'webchat', platformId: 'room-1' });
  });

  it('does not re-forward already-seen rows', async () => {
    await forwardSessionStatus(session); // seed
    append('tool', 'Bash', 'ls');
    await forwardSessionStatus(session);
    expect(captured).toHaveLength(1);
    await forwardSessionStatus(session); // nothing new
    expect(captured).toHaveLength(1);
  });

  it('forwards across a per-turn clear (monotonic seq)', async () => {
    await forwardSessionStatus(session); // seed at 0
    append('tool', 'Read', 'x.ts');
    await forwardSessionStatus(session);
    expect(captured).toHaveLength(1);

    // New turn clears the table; AUTOINCREMENT keeps seq climbing.
    const db = new Database(OUT_PATH);
    db.prepare('DELETE FROM status_events').run();
    db.close();
    append('progress', 'Second turn');
    await forwardSessionStatus(session);
    expect(captured.map((c) => c.status.text)).toEqual(['Read', 'Second turn']);
  });

  it('stays silent when the session has no messaging group', async () => {
    messagingGroup = undefined;
    append('progress', 'orphan');
    await forwardSessionStatus(session);
    expect(captured).toHaveLength(0);
  });
});

describe('notifySessionStopped (mid-turn death)', () => {
  it('broadcasts a stalled notice when the container dies mid-turn', async () => {
    await forwardSessionStatus(session); // seed
    append('start', null);
    append('tool', 'Bash', 'sleep 9999');
    await forwardSessionStatus(session); // forwards start (turn active) + tool
    captured.length = 0;

    await notifySessionStopped(session);
    expect(captured).toHaveLength(1);
    expect(captured[0].status.kind).toBe('stalled');
    expect(captured[0].status.text).toMatch(/stopped responding/i);
  });

  it('is silent after a clean done (idle exit is not a stall)', async () => {
    await forwardSessionStatus(session); // seed
    append('start', null);
    append('done', null);
    await forwardSessionStatus(session); // start then done → turn no longer active
    captured.length = 0;

    await notifySessionStopped(session);
    expect(captured).toHaveLength(0);
  });

  it('is idempotent — only one stall per turn', async () => {
    await forwardSessionStatus(session); // seed
    append('start', null);
    await forwardSessionStatus(session);
    captured.length = 0;

    await notifySessionStopped(session);
    await notifySessionStopped(session);
    expect(captured).toHaveLength(1);
  });

  it('is silent for a session that never started a turn', async () => {
    await forwardSessionStatus(session); // seed, no start
    captured.length = 0;
    await notifySessionStopped(session);
    expect(captured).toHaveLength(0);
  });
});
