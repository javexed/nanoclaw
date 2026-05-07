/**
 * Tests for the role-gating primitives in roles.ts.
 *
 * These functions are the load-bearing authorization layer for every
 * webchat HTTP endpoint that mutates state. Bugs here trade user
 * isolation for user impersonation, so they get unit coverage on the
 * full matrix of role rows + agent_group_id scoping.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { ensureOwnerRoleOnFirstLogin, hasAdminPrivilege, isOwner } from './roles.js';

beforeEach(() => {
  initTestDb();
});

afterEach(() => {
  closeDb();
});

function insertRole(userId: string, role: 'owner' | 'admin' | 'member', agentGroupId: string | null): void {
  const db = getDb();
  // user_roles has an FK to users; satisfy it idempotently.
  db.prepare(`INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'webchat', NULL, ?)`).run(
    userId,
    new Date().toISOString(),
  );
  // Scoped roles need a real agent_groups row to satisfy the FK on
  // agent_group_id. Create a stub if the test asks for one.
  if (agentGroupId) {
    db.prepare(
      `INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, created_at)
       VALUES (?, ?, ?, NULL, ?)`,
    ).run(agentGroupId, agentGroupId, agentGroupId, new Date().toISOString());
  }
  db.prepare(
    `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
     VALUES (?, ?, ?, NULL, ?)`,
  ).run(userId, role, agentGroupId, new Date().toISOString());
}

describe('isOwner', () => {
  it('returns true for any user when user_roles table is missing (fail-open)', () => {
    // No migrations run — user_roles doesn't exist.
    expect(isOwner('webchat:anyone')).toBe(true);
  });

  it('returns true only for global-owner rows (agent_group_id IS NULL)', () => {
    runMigrations(getDb());
    insertRole('webchat:alice', 'owner', null);
    expect(isOwner('webchat:alice')).toBe(true);
    expect(isOwner('webchat:bob')).toBe(false);
  });

  it("does not treat 'admin' rows as owner", () => {
    runMigrations(getDb());
    insertRole('webchat:alice', 'admin', null); // global admin
    expect(isOwner('webchat:alice')).toBe(false);
  });

  it("does not treat scoped 'owner' rows as owner (agent_group_id != NULL)", () => {
    runMigrations(getDb());
    // Anomalous row — not created by webchat itself, but if some other
    // module inserts (alice, owner, ag-1), isOwner shouldn't grant
    // global owner privileges.
    insertRole('webchat:alice', 'owner', 'ag-1');
    expect(isOwner('webchat:alice')).toBe(false);
  });

  it("ignores 'member' rows", () => {
    runMigrations(getDb());
    insertRole('webchat:alice', 'member', null);
    expect(isOwner('webchat:alice')).toBe(false);
  });
});

describe('hasAdminPrivilege', () => {
  it('returns true for any user when user_roles table is missing (fail-open)', () => {
    expect(hasAdminPrivilege('webchat:anyone', 'ag-1')).toBe(true);
  });

  it('global owner has admin privilege over every agent group', () => {
    runMigrations(getDb());
    insertRole('webchat:alice', 'owner', null);
    expect(hasAdminPrivilege('webchat:alice', 'ag-1')).toBe(true);
    expect(hasAdminPrivilege('webchat:alice', 'ag-2')).toBe(true);
  });

  it('global admin (agent_group_id NULL) has admin privilege over every agent group', () => {
    runMigrations(getDb());
    insertRole('webchat:alice', 'admin', null);
    expect(hasAdminPrivilege('webchat:alice', 'ag-1')).toBe(true);
    expect(hasAdminPrivilege('webchat:alice', 'ag-99')).toBe(true);
  });

  it('scoped admin matches only the scoped agent_group_id', () => {
    runMigrations(getDb());
    insertRole('webchat:alice', 'admin', 'ag-1');
    expect(hasAdminPrivilege('webchat:alice', 'ag-1')).toBe(true);
    expect(hasAdminPrivilege('webchat:alice', 'ag-2')).toBe(false);
  });

  it("'member' rows do not grant admin privilege", () => {
    runMigrations(getDb());
    insertRole('webchat:alice', 'member', null);
    insertRole('webchat:alice', 'member', 'ag-1');
    expect(hasAdminPrivilege('webchat:alice', 'ag-1')).toBe(false);
  });

  it('returns false for users with no roles', () => {
    runMigrations(getDb());
    expect(hasAdminPrivilege('webchat:nobody', 'ag-1')).toBe(false);
  });
});

describe('ensureOwnerRoleOnFirstLogin', () => {
  it('is a no-op when user_roles table is absent', () => {
    // Permissions module not installed; helper bails out cleanly.
    expect(() => ensureOwnerRoleOnFirstLogin('webchat:alice')).not.toThrow();
  });

  it('creates an owner row on first call', () => {
    runMigrations(getDb());
    ensureOwnerRoleOnFirstLogin('webchat:alice');
    expect(isOwner('webchat:alice')).toBe(true);
  });

  it('is idempotent — second call does not change ownership', () => {
    runMigrations(getDb());
    ensureOwnerRoleOnFirstLogin('webchat:alice');
    ensureOwnerRoleOnFirstLogin('webchat:alice');
    const ownerCount = (
      getDb().prepare(`SELECT COUNT(*) AS c FROM user_roles WHERE role='owner'`).get() as { c: number }
    ).c;
    expect(ownerCount).toBe(1);
  });

  it('does not promote a second user when an owner already exists', () => {
    runMigrations(getDb());
    ensureOwnerRoleOnFirstLogin('webchat:alice');
    ensureOwnerRoleOnFirstLogin('webchat:bob');
    expect(isOwner('webchat:alice')).toBe(true);
    expect(isOwner('webchat:bob')).toBe(false);
    const ownerCount = (
      getDb().prepare(`SELECT COUNT(*) AS c FROM user_roles WHERE role='owner'`).get() as { c: number }
    ).c;
    expect(ownerCount).toBe(1);
  });

  it('atomic guard: simulated concurrent first-login produces exactly one owner', () => {
    // The check-and-insert is atomic via INSERT ... WHERE NOT EXISTS,
    // so even back-to-back calls intended to race can't double-insert.
    // We simulate the race by calling many times with different userIds
    // in sequence (single-threaded JS, but each call independently does
    // the WHERE-NOT-EXISTS check).
    runMigrations(getDb());
    for (const u of ['webchat:alice', 'webchat:bob', 'webchat:carol', 'webchat:dave']) {
      ensureOwnerRoleOnFirstLogin(u);
    }
    const ownerCount = (
      getDb().prepare(`SELECT COUNT(*) AS c FROM user_roles WHERE role='owner'`).get() as { c: number }
    ).c;
    expect(ownerCount).toBe(1);
    // First caller wins.
    expect(isOwner('webchat:alice')).toBe(true);
  });

  it('creates a users row with kind=webchat when users table exists', () => {
    runMigrations(getDb());
    ensureOwnerRoleOnFirstLogin('webchat:alice');
    const row = getDb().prepare(`SELECT kind FROM users WHERE id = ?`).get('webchat:alice') as
      | { kind: string }
      | undefined;
    expect(row?.kind).toBe('webchat');
  });
});
