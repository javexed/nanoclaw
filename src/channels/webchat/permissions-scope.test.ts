/**
 * Tests for listUsersWithPermissions() caller-scoping.
 *
 * /api/users is open to any admin (not just owners), so the response must be
 * scoped per-caller: a *scoped* admin may see the full user list (so they can
 * add anyone as a member of their group) but must NOT see the global
 * owner/admin roster or other groups' role/membership assignments. Owners and
 * global admins get the full cross-group matrix.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { listUsersWithPermissions } from './server.js';

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});
afterEach(() => closeDb());

const now = '2026-06-10T00:00:00.000Z';

function user(id: string): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'webchat', NULL, ?)`)
    .run(id, now);
}
function group(id: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`,
    )
    .run(id, id, id, now);
}
function role(userId: string, r: 'owner' | 'admin', agentGroupId: string | null): void {
  user(userId);
  if (agentGroupId) group(agentGroupId);
  getDb()
    .prepare(`INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, ?, NULL, ?)`)
    .run(userId, r, agentGroupId, now);
}
function member(userId: string, agentGroupId: string): void {
  user(userId);
  group(agentGroupId);
  getDb()
    .prepare(`INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, NULL, ?)`)
    .run(userId, agentGroupId, now);
}

function find(rows: ReturnType<typeof listUsersWithPermissions>, id: string) {
  return rows.find((u) => u.id === id)!;
}

describe('listUsersWithPermissions caller-scoping', () => {
  beforeEach(() => {
    role('webchat:owner', 'owner', null);
    role('webchat:sadmin', 'admin', 'ag-1'); // scoped admin of ag-1 only
    // Target user: member of ag-1 AND ag-2, plus a scoped-admin role on ag-2.
    role('webchat:bob', 'admin', 'ag-2');
    member('webchat:bob', 'ag-1');
    member('webchat:bob', 'ag-2');
  });

  it('owner sees the full cross-group matrix', () => {
    const rows = listUsersWithPermissions('webchat:owner');
    const bob = find(rows, 'webchat:bob');
    expect(bob.memberships.map((m) => m.agent_group_id).sort()).toEqual(['ag-1', 'ag-2']);
    expect(bob.roles.map((r) => r.agent_group_id)).toContain('ag-2');
    // Owner is visible in the roster (global owner row present).
    expect(find(rows, 'webchat:owner').roles.some((r) => r.kind === 'owner')).toBe(true);
  });

  it('scoped admin sees only assignments within their administered group', () => {
    const rows = listUsersWithPermissions('webchat:sadmin');
    const bob = find(rows, 'webchat:bob');
    // ag-1 membership visible; ag-2 membership hidden.
    expect(bob.memberships.map((m) => m.agent_group_id)).toEqual(['ag-1']);
    // bob's admin/ag-2 role is outside ag-1 → filtered out.
    expect(bob.roles).toHaveLength(0);
    // The global owner roster is hidden from a scoped admin.
    expect(find(rows, 'webchat:owner').roles).toHaveLength(0);
  });

  it('user LIST stays unfiltered so a scoped admin can add any user', () => {
    const rows = listUsersWithPermissions('webchat:sadmin');
    // Every user is still enumerable (so they can be granted membership),
    // even though their cross-group detail is scoped away.
    expect(rows.map((u) => u.id).sort()).toEqual(['webchat:bob', 'webchat:owner', 'webchat:sadmin']);
  });

  it('no caller (legacy/internal call) gets the full matrix', () => {
    const bob = find(listUsersWithPermissions(), 'webchat:bob');
    expect(bob.memberships).toHaveLength(2);
  });
});
