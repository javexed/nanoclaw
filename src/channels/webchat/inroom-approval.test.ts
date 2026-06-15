/**
 * Tests for in-room approval cards:
 *  - storeWebchatApprovalCard writes an actionable 'approval' row (carrying the
 *    eligible approvers), and markRoomApprovalResolved flips it to resolved;
 *  - the approval-requested listener registry fires.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { storeWebchatApprovalCard, markRoomApprovalResolved } from './db.js';
import { registerApprovalRequestedListener, notifyApprovalRequested } from '../../modules/approvals/primitive.js';
import type { Session } from '../../types.js';

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});
afterEach(() => closeDb());

function cardRow(approvalId: string) {
  return getDb()
    .prepare(`SELECT room_id, sender, message_type, content FROM webchat_messages WHERE id = ?`)
    .get(`appr-card-${approvalId}`) as
    | { room_id: string; sender: string; message_type: string; content: string }
    | undefined;
}

describe('in-room approval card', () => {
  it('stores an actionable approval row with the eligible approvers', () => {
    storeWebchatApprovalCard('financial-floor', 'greensight', {
      questionId: 'appr-1',
      title: 'Install Packages Request',
      question: 'install jq?',
      options: [],
      action: 'install_packages',
      approvers: ['webchat:tailscale:a@x.com', 'webchat:tailscale:b@x.com'],
    });
    const row = cardRow('appr-1')!;
    expect(row.room_id).toBe('financial-floor');
    expect(row.sender).toBe('greensight');
    expect(row.message_type).toBe('approval');
    const c = JSON.parse(row.content);
    expect(c.questionId).toBe('appr-1');
    expect(c.approvers).toEqual(['webchat:tailscale:a@x.com', 'webchat:tailscale:b@x.com']);
  });

  it('markRoomApprovalResolved flips the card to resolved + records who', () => {
    storeWebchatApprovalCard('financial-floor', 'greensight', {
      questionId: 'appr-2',
      title: 'T',
      question: 'q',
      options: [],
      action: 'install_packages',
      approvers: [],
    });
    markRoomApprovalResolved('appr-2', 'webchat:tailscale:a@x.com');
    const row = cardRow('appr-2')!;
    expect(row.message_type).toBe('approval_resolved');
    expect(JSON.parse(row.content).resolvedBy).toBe('webchat:tailscale:a@x.com');
  });

  it('re-storing the same approvalId is idempotent (INSERT OR REPLACE)', () => {
    const p = {
      questionId: 'appr-3',
      title: 'T',
      question: 'q',
      options: [],
      action: 'x',
      approvers: [],
    };
    storeWebchatApprovalCard('room', 'a', p);
    storeWebchatApprovalCard('room', 'a', p);
    const n = getDb().prepare(`SELECT COUNT(*) AS n FROM webchat_messages WHERE id='appr-card-appr-3'`).get() as {
      n: number;
    };
    expect(n.n).toBe(1);
  });

  it('markRoomApprovalResolved is a no-op for an unknown approval', () => {
    expect(() => markRoomApprovalResolved('nope', 'x')).not.toThrow();
  });
});

describe('approval-requested listener', () => {
  it('fires registered listeners with the event', () => {
    const seen: string[] = [];
    registerApprovalRequestedListener((e) => seen.push(e.approvalId));
    notifyApprovalRequested({
      approvalId: 'appr-x',
      session: { id: 's1', agent_group_id: 'ag', messaging_group_id: 'mg' } as Session,
      action: 'install_packages',
      title: 'T',
      question: 'q',
      options: [],
      approvers: [],
    });
    expect(seen).toContain('appr-x');
  });
});
