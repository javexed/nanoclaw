/**
 * Tests for checkMemberGrantAuth — the privilege boundary shared by
 * /api/permissions/grant and /revoke.
 *
 * This is the guard that lets scoped admins delegate *member* access on their
 * own groups while keeping role escalation (admin/owner) and cross-group
 * member changes owner-only. A regression here trades user isolation for
 * privilege escalation, so the full matrix gets locked down.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { checkMemberGrantAuth } from './server.js';

const now = '2026-06-10T00:00:00.000Z';

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});
afterEach(() => closeDb());

function role(userId: string, r: 'owner' | 'admin', agentGroupId: string | null): void {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'webchat', NULL, ?)`).run(
    userId,
    now,
  );
  if (agentGroupId) {
    db.prepare(
      `INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`,
    ).run(agentGroupId, agentGroupId, agentGroupId, now);
  }
  db.prepare(
    `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, ?, NULL, ?)`,
  ).run(userId, r, agentGroupId, now);
}

const allowed = (v: ReturnType<typeof checkMemberGrantAuth>) => v === null;
const denied = (v: ReturnType<typeof checkMemberGrantAuth>) => v !== null;

describe('checkMemberGrantAuth', () => {
  it('owner may grant/revoke anything (member, admin, owner; any/no group)', () => {
    role('webchat:owner', 'owner', null);
    expect(allowed(checkMemberGrantAuth('webchat:owner', 'member', 'ag-1'))).toBe(true);
    expect(allowed(checkMemberGrantAuth('webchat:owner', 'admin', 'ag-1'))).toBe(true);
    expect(allowed(checkMemberGrantAuth('webchat:owner', 'owner', null))).toBe(true);
    expect(allowed(checkMemberGrantAuth('webchat:owner', 'member', 'ag-other'))).toBe(true);
  });

  it('scoped admin may grant member on their own group', () => {
    role('webchat:sadmin', 'admin', 'ag-1');
    expect(allowed(checkMemberGrantAuth('webchat:sadmin', 'member', 'ag-1'))).toBe(true);
  });

  it('scoped admin may NOT grant admin or owner (escalation blocked)', () => {
    role('webchat:sadmin', 'admin', 'ag-1');
    expect(checkMemberGrantAuth('webchat:sadmin', 'admin', 'ag-1')).toEqual({ error: 'Owner only' });
    expect(checkMemberGrantAuth('webchat:sadmin', 'owner', null)).toEqual({ error: 'Owner only' });
  });

  it('scoped admin may NOT grant member on a group they do not administer', () => {
    role('webchat:sadmin', 'admin', 'ag-1');
    expect(checkMemberGrantAuth('webchat:sadmin', 'member', 'ag-2')).toEqual({
      error: 'Admin privilege required for this group',
    });
  });

  it('member grant with no group is rejected even for a scoped admin', () => {
    role('webchat:sadmin', 'admin', 'ag-1');
    expect(checkMemberGrantAuth('webchat:sadmin', 'member', null)).toEqual({
      error: 'Admin privilege required for this group',
    });
    // Non-string group ids are treated as null.
    expect(denied(checkMemberGrantAuth('webchat:sadmin', 'member', 42))).toBe(true);
  });

  it('global admin may grant member on any group but not roles', () => {
    role('webchat:gadmin', 'admin', null); // global admin (agent_group_id NULL)
    expect(allowed(checkMemberGrantAuth('webchat:gadmin', 'member', 'ag-1'))).toBe(true);
    expect(allowed(checkMemberGrantAuth('webchat:gadmin', 'member', 'ag-99'))).toBe(true);
    expect(checkMemberGrantAuth('webchat:gadmin', 'admin', 'ag-1')).toEqual({ error: 'Owner only' });
  });

  it('a user with no roles is denied everything', () => {
    expect(denied(checkMemberGrantAuth('webchat:nobody', 'member', 'ag-1'))).toBe(true);
    expect(checkMemberGrantAuth('webchat:nobody', 'admin', 'ag-1')).toEqual({ error: 'Owner only' });
  });
});
