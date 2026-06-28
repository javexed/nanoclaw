/**
 * Phase 4: shared-context fan-out. On a per-member wake, the member's session
 * receives the full room transcript — current message trigger=1, the rest
 * trigger=0 — idempotently. The INVARIANT that matters: exactly one trigger=1
 * (the current message); everything else is context.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createSession } from '../../db/sessions.js';
import { openInboundDb, initSessionFolder } from '../../session-manager.js';
import { storeWebchatMessage } from '../../channels/webchat/db.js';
import { writeMemberTranscript } from './fanout.js';
import type { Session } from '../../types.js';

const SESSION: Session = {
  id: 'sess-alice',
  agent_group_id: 'ag-1',
  messaging_group_id: 'mg-1',
  thread_id: 'webchat:alice',
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: 't',
} as Session;

function seedSession() {
  getDb()
    .prepare(`INSERT OR IGNORE INTO agent_groups (id,name,folder,agent_provider,created_at) VALUES ('ag-1','ag-1','ag-1',NULL,'t')`)
    .run();
  getDb()
    .prepare(
      `INSERT INTO messaging_groups (id,channel_type,instance,platform_id,created_at) VALUES ('mg-1','webchat','webchat','room-1','t')`,
    )
    .run();
  createSession(SESSION);
  initSessionFolder('ag-1', 'sess-alice'); // scaffolds the session dir + inbound.db
}

function inboundRows() {
  const db = openInboundDb('ag-1', 'sess-alice');
  try {
    return db.prepare('SELECT id, trigger, content FROM messages_in ORDER BY seq').all() as {
      id: string;
      trigger: number;
      content: string;
    }[];
  } finally {
    db.close();
  }
}

const addr = { platformId: 'room-1', channelType: 'webchat', threadId: null };

const testSessionTree = path.join(DATA_DIR, 'v2-sessions', 'ag-1');

beforeEach(() => {
  fs.rmSync(testSessionTree, { recursive: true, force: true }); // fresh session dir each test
  initTestDb();
  runMigrations(getDb());
  seedSession();
});
afterEach(() => {
  closeDb();
  fs.rmSync(testSessionTree, { recursive: true, force: true });
});

describe('writeMemberTranscript', () => {
  it('writes the transcript with exactly one trigger=1 (the current message)', () => {
    const a = storeWebchatMessage('room-1', 'Alice', 'user', 'hi from alice');
    const b = storeWebchatMessage('room-1', 'Bob', 'user', 'hi from bob');
    const cur = storeWebchatMessage('room-1', 'Alice', 'user', 'what did bob say?');
    const handled = writeMemberTranscript({
      agentGroupId: 'ag-1',
      session: SESSION,
      roomId: 'room-1',
      currentMessageId: cur.id,
      deliveryAddr: addr,
    });
    expect(handled).toBe(true);
    const rows = inboundRows();
    expect(rows).toHaveLength(3);
    const triggers = rows.filter((r) => r.trigger === 1);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].id).toBe(`byok-sess-alice-${cur.id}`);
    // Bob's message is present as context (shared transcript).
    expect(rows.some((r) => r.content.includes('hi from bob') && r.trigger === 0)).toBe(true);
    void [a, b];
  });

  it('is idempotent — re-running adds only genuinely new messages', () => {
    const m1 = storeWebchatMessage('room-1', 'Alice', 'user', 'one');
    writeMemberTranscript({ agentGroupId: 'ag-1', session: SESSION, roomId: 'room-1', currentMessageId: m1.id, deliveryAddr: addr });
    expect(inboundRows()).toHaveLength(1);
    // Same turn re-run → no dup.
    writeMemberTranscript({ agentGroupId: 'ag-1', session: SESSION, roomId: 'room-1', currentMessageId: m1.id, deliveryAddr: addr });
    expect(inboundRows()).toHaveLength(1);
    // A new message arrives → only it is added (idempotent: m1 not rewritten,
    // keeps its original trigger; the new current message is trigger=1).
    const m2 = storeWebchatMessage('room-1', 'Alice', 'user', 'two');
    writeMemberTranscript({ agentGroupId: 'ag-1', session: SESSION, roomId: 'room-1', currentMessageId: m2.id, deliveryAddr: addr });
    const rows = inboundRows();
    expect(rows).toHaveLength(2); // no duplication
    expect(rows.find((r) => r.id === `byok-sess-alice-${m2.id}`)!.trigger).toBe(1); // current wakes
  });

  it('falls back (returns false) when the current message is not in the transcript', () => {
    storeWebchatMessage('room-1', 'Alice', 'user', 'old');
    const handled = writeMemberTranscript({
      agentGroupId: 'ag-1',
      session: SESSION,
      roomId: 'room-1',
      currentMessageId: 'not-in-room',
      deliveryAddr: addr,
    });
    expect(handled).toBe(false);
  });

  it('skips a2a / approval side-channel rows', () => {
    const cur = storeWebchatMessage('room-1', 'Alice', 'user', 'hello');
    // an a2a side-channel row in the same room
    getDb()
      .prepare(
        `INSERT INTO webchat_messages (id, room_id, sender, sender_type, content, message_type, created_at)
         VALUES ('a2a-1','room-1','x','a2a','{"to":"y","text":"z"}','a2a', ${Date.now() - 1000})`,
      )
      .run();
    writeMemberTranscript({ agentGroupId: 'ag-1', session: SESSION, roomId: 'room-1', currentMessageId: cur.id, deliveryAddr: addr });
    const rows = inboundRows();
    expect(rows.some((r) => r.id === 'byok-sess-alice-a2a-1')).toBe(false);
  });
});
