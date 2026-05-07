/**
 * Webchat role helpers.
 *
 * v2 has a `permissions` module that owns `user_roles` (`webchat:owner`,
 * `webchat:admin`, scoped admins). When that module isn't installed the
 * helpers degrade to "trust authenticated callers" — the channel itself
 * still authenticates, but admin gating becomes a no-op.
 *
 * All schema knowledge for `user_roles` and `users` lives here so it stays
 * consolidated when the schema evolves; auth.ts and server.ts go through
 * this file rather than running their own queries.
 *
 * Privilege matrix (`user_roles` rows):
 *   role='owner', agent_group_id IS NULL  → global owner
 *   role='admin', agent_group_id IS NULL  → global admin (every group)
 *   role='admin', agent_group_id = X      → scoped admin (only group X)
 *   role='owner', agent_group_id = X      → not used by webchat; the
 *                                            permissions module does not
 *                                            create scoped owners. If such a
 *                                            row exists from another caller,
 *                                            hasAdminPrivilege treats it as
 *                                            scoped-admin-of-X for safety.
 */
import { getDb, hasTable } from '../../db/connection.js';
import { log } from '../../log.js';

export function isOwner(userId: string): boolean {
  const db = getDb();
  if (!hasTable(db, 'user_roles')) return true; // no permissions module = trust authenticated
  const row = db
    .prepare(`SELECT 1 FROM user_roles WHERE user_id = ? AND role = 'owner' AND agent_group_id IS NULL`)
    .get(userId);
  return !!row;
}

export function hasAdminPrivilege(userId: string, agentGroupId: string): boolean {
  const db = getDb();
  if (!hasTable(db, 'user_roles')) return true;
  const row = db
    .prepare(
      `SELECT 1 FROM user_roles
       WHERE user_id = ?
         AND (role = 'owner' OR role = 'admin')
         AND (agent_group_id IS NULL OR agent_group_id = ?)`,
    )
    .get(userId, agentGroupId);
  return !!row;
}

/**
 * When permissions is installed and there is no owner yet, promote this
 * caller. This is the v2 replacement for v1's "main group" — first
 * authenticated webchat operator becomes the owner. Idempotent: a system
 * that already has an owner skips this entirely.
 *
 * The check-and-insert is atomic via `INSERT ... WHERE NOT EXISTS`. Two
 * concurrent first-time logins can't race into a "two co-owners" state —
 * SQLite's row-level write lock plus the WHERE-NOT-EXISTS subquery means
 * exactly one INSERT succeeds.
 */
export function ensureOwnerRoleOnFirstLogin(userId: string): void {
  const db = getDb();
  if (!hasTable(db, 'user_roles')) return; // permissions module not installed

  // Make sure the user row exists so the role grant's audit trail has somewhere
  // to point. Use INSERT OR IGNORE in case the senderResolver beat us to it.
  if (hasTable(db, 'users')) {
    db.prepare(
      `INSERT OR IGNORE INTO users (id, kind, display_name, created_at)
       VALUES (?, 'webchat', NULL, ?)`,
    ).run(userId, new Date().toISOString());
  }
  try {
    // Atomic guard: insert iff there's no owner yet. SQLite evaluates the
    // SELECT and INSERT in one statement under a row-write lock, so a
    // concurrent caller racing the same first-login window can't squeeze
    // a second INSERT through. Subsequent calls see an owner exists and
    // the INSERT inserts zero rows (no error).
    const result = db
      .prepare(
        `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
         SELECT ?, 'owner', NULL, NULL, ?
         WHERE NOT EXISTS (SELECT 1 FROM user_roles WHERE role = 'owner')`,
      )
      .run(userId, new Date().toISOString());
    if (result.changes > 0) {
      log.info('Webchat: granted owner role to first authenticated user', { userId });
    }
  } catch (err) {
    log.warn('Webchat: failed to grant initial owner role', { userId, err });
  }
}

/**
 * Optional startup probe — log a fatal-style warning when the permissions
 * module isn't installed, so an operator notices the fail-open posture.
 * Doesn't change runtime behavior; some installs deliberately skip the
 * permissions module (single-operator deploys behind explicit auth).
 */
export function warnIfNoPermissionsModule(): void {
  if (!hasTable(getDb(), 'user_roles')) {
    log.warn(
      'Webchat: permissions module not installed — every authenticated caller has owner-equivalent access. ' +
        'This is fine for single-operator setups behind explicit auth (Tailscale / bearer token / proxy header) ' +
        'but unsafe for shared deployments. Install the permissions module via /setup if multiple humans share this install.',
    );
  }
}
