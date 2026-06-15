/**
 * Tests for approval fan-out:
 *  - the composite-PK migration lets one approval be indexed against multiple
 *    inboxes, and the read path surfaces it to each approver;
 *  - the resolved-listener registry fires on resolution (drives the clear).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createPendingApproval } from '../../db/sessions.js';
import {
  recordWebchatApproval,
  isWebchatApprovalIndexedFor,
  getWebchatApprovalInboxes,
  deleteWebchatApprovalIndex,
  userForApprovalInbox,
  getWebchatPendingApprovalsForUser,
} from './db.js';

const INBOX_A = 'approvals:tailscale:a@example.com';
const INBOX_B = 'approvals:tailscale:b@example.com';

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});

afterEach(() => {
  closeDb();
});

describe('webchat_approvals_index — multi-inbox (fan-out)', () => {
  it('indexes one approval against multiple inboxes', () => {
    recordWebchatApproval('appr-1', INBOX_A);
    recordWebchatApproval('appr-1', INBOX_B);
    expect(getWebchatApprovalInboxes('appr-1').sort()).toEqual([INBOX_A, INBOX_B].sort());
    expect(isWebchatApprovalIndexedFor('appr-1', INBOX_A)).toBe(true);
    expect(isWebchatApprovalIndexedFor('appr-1', INBOX_B)).toBe(true);
    expect(isWebchatApprovalIndexedFor('appr-1', 'approvals:tailscale:c@example.com')).toBe(false);
  });

  it('surfaces a fanned-out approval to every indexed approver', () => {
    createPendingApproval({
      approval_id: 'appr-2',
      session_id: null,
      request_id: 'appr-2',
      action: 'install_packages',
      payload: '{}',
      created_at: new Date().toISOString(),
      title: 'Install Packages Request',
      options_json: '[]',
    });
    recordWebchatApproval('appr-2', INBOX_A);
    recordWebchatApproval('appr-2', INBOX_B);
    const forA = getWebchatPendingApprovalsForUser('webchat:tailscale:a@example.com');
    const forB = getWebchatPendingApprovalsForUser('webchat:tailscale:b@example.com');
    expect(forA.map((r) => r.approval_id)).toContain('appr-2');
    expect(forB.map((r) => r.approval_id)).toContain('appr-2');
  });

  it('deleteWebchatApprovalIndex clears all rows for an approval', () => {
    recordWebchatApproval('appr-3', INBOX_A);
    recordWebchatApproval('appr-3', INBOX_B);
    deleteWebchatApprovalIndex('appr-3');
    expect(getWebchatApprovalInboxes('appr-3')).toEqual([]);
  });

  it('userForApprovalInbox inverts approvalInboxForUser', () => {
    expect(userForApprovalInbox(INBOX_A)).toBe('webchat:tailscale:a@example.com');
    expect(userForApprovalInbox('not-an-inbox')).toBeNull();
  });
});
