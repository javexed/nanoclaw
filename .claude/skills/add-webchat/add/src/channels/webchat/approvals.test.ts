/**
 * Tests for the per-user approvals inbox primitives.
 *
 * Webchat's openDM path produces synthetic `approvals:<handle>`
 * platform_ids. To find "approvals for this user" without depending on a
 * trunk-side stamp on `pending_approvals.platform_id`, the skill
 * maintains its own `webchat_approvals_index` table — webchat's
 * `deliver()` writes to it when an approval lands on a webchat
 * approval-inbox, and the inbox query JOINs against it.
 */
import { randomUUID } from 'crypto';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import {
  APPROVAL_INBOX_PREFIX,
  approvalInboxForUser,
  getAllWebchatRooms,
  getWebchatPendingApprovalsForUser,
  isApprovalInbox,
  recordWebchatApproval,
} from './db.js';

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});

afterEach(() => {
  closeDb();
});

function insertRoomLikeMessagingGroup(platformId: string, name: string): void {
  getDb()
    .prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, 'webchat', ?, ?, 0, 'public', ?)`,
    )
    .run(randomUUID(), platformId, name, new Date().toISOString());
}

function insertPendingApproval(opts: {
  approvalId: string;
  platformId: string | null;
  status?: string;
  action?: string;
  title?: string;
}): void {
  // Insert the approval row exactly the way trunk's requestApproval would
  // — without the platform_id stamp (those columns stay NULL on real
  // installs because trunk's primitive doesn't populate them).
  getDb()
    .prepare(
      `INSERT INTO pending_approvals
         (approval_id, session_id, request_id, action, payload, created_at,
          agent_group_id, channel_type, platform_id, platform_message_id,
          expires_at, status, title, options_json)
       VALUES
         (@approval_id, NULL, @approval_id, @action, '{}', @created_at,
          NULL, NULL, NULL, NULL,
          NULL, @status, @title, '[]')`,
    )
    .run({
      approval_id: opts.approvalId,
      action: opts.action ?? 'install_packages',
      created_at: new Date().toISOString(),
      status: opts.status ?? 'pending',
      title: opts.title ?? 'Test Approval',
    });
  // If a platformId is provided, simulate the webchat deliver() path
  // that records the inbox mapping. Tests with platformId=null model
  // approvals delivered to a non-webchat channel — they correctly stay
  // out of the webchat inbox.
  if (opts.platformId !== null) {
    recordWebchatApproval(opts.approvalId, opts.platformId);
  }
}

describe('approvalInboxForUser', () => {
  it('maps webchat user_ids to the approvals: platform_id', () => {
    expect(approvalInboxForUser('webchat:tailscale:foo@example.com')).toBe('approvals:tailscale:foo@example.com');
  });

  it('returns null for non-webchat user_ids', () => {
    expect(approvalInboxForUser('slack:U123')).toBeNull();
    expect(approvalInboxForUser('cli:local')).toBeNull();
  });
});

describe('isApprovalInbox', () => {
  it('matches the approvals: prefix', () => {
    expect(isApprovalInbox(`${APPROVAL_INBOX_PREFIX}foo@example.com`)).toBe(true);
    expect(isApprovalInbox('cli-local')).toBe(false);
    expect(isApprovalInbox('approvals')).toBe(false); // no colon → not the prefix
  });
});

describe('getAllWebchatRooms hides approval inboxes', () => {
  it('filters platform_ids starting with approvals:', () => {
    insertRoomLikeMessagingGroup('cli-local', 'Real Room');
    insertRoomLikeMessagingGroup('approvals:tailscale:foo@example.com', 'Hidden Inbox');

    const rooms = getAllWebchatRooms();
    expect(rooms.map((r) => r.id)).toEqual(['cli-local']);
  });
});

describe('getWebchatPendingApprovalsForUser', () => {
  const userId = 'webchat:tailscale:owner@example.com';
  const platformId = 'approvals:tailscale:owner@example.com';

  it('returns only approvals stamped with this user platform_id', () => {
    insertPendingApproval({ approvalId: 'a-mine', platformId });
    insertPendingApproval({ approvalId: 'a-other', platformId: 'approvals:tailscale:other@example.com' });
    insertPendingApproval({ approvalId: 'a-noplat', platformId: null });

    const rows = getWebchatPendingApprovalsForUser(userId);
    expect(rows.map((r) => r.approval_id)).toEqual(['a-mine']);
  });

  it('hides resolved approvals (status != pending)', () => {
    insertPendingApproval({ approvalId: 'a-pending', platformId });
    insertPendingApproval({ approvalId: 'a-approved', platformId, status: 'approved' });
    insertPendingApproval({ approvalId: 'a-rejected', platformId, status: 'rejected' });

    const rows = getWebchatPendingApprovalsForUser(userId);
    expect(rows.map((r) => r.approval_id)).toEqual(['a-pending']);
  });

  it('returns nothing for non-webchat users', () => {
    insertPendingApproval({ approvalId: 'a-1', platformId: 'approvals:U123' });
    expect(getWebchatPendingApprovalsForUser('slack:U123')).toEqual([]);
  });
});

describe('recordWebchatApproval idempotency', () => {
  it('INSERT OR IGNORE: re-recording the same approval_id is a no-op', () => {
    const platformId = 'approvals:tailscale:foo@example.com';
    recordWebchatApproval('a-dup', platformId);
    // Capture the original recorded_at so we can assert it stays put.
    const before = getDb()
      .prepare(`SELECT recorded_at FROM webchat_approvals_index WHERE approval_id = ?`)
      .get('a-dup') as { recorded_at: number } | undefined;
    expect(before).toBeDefined();
    // Re-record with a different platform_id — the OR IGNORE means the
    // first-write-wins. Without OR IGNORE this would either UPDATE or
    // throw on the PK collision.
    recordWebchatApproval('a-dup', 'approvals:tailscale:other@example.com');
    const rows = getDb()
      .prepare(`SELECT approval_id, platform_id, recorded_at FROM webchat_approvals_index WHERE approval_id = ?`)
      .all('a-dup') as { approval_id: string; platform_id: string; recorded_at: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].platform_id).toBe(platformId);
    expect(rows[0].recorded_at).toBe(before!.recorded_at);
  });
});
