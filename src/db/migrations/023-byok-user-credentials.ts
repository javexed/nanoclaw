import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * BYOK per-USER credential (central DB) — the connect-time source of truth.
 *
 * A member connects once: their credential lands here as one row per
 * (user, provider), holding the single OneCLI vault `secret_id`. Per-(user,
 * agent-group) enrollment in `byok_credentials` is then created lazily, the
 * first time the member actually uses a given room (see ensureGroupEnrollment),
 * rather than eagerly for every room at connect time. So "connect once" applies
 * to every room — including ones added later — with no per-room proliferation.
 *
 * Migrates existing eager enrollments: any active per-group row with a secret
 * seeds the matching user-level row, so already-connected members stay connected.
 */
export const migration023: Migration = {
  version: 23,
  name: 'byok-user-credentials',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS byok_user_credentials (
        user_id    TEXT NOT NULL,
        provider   TEXT NOT NULL DEFAULT 'claude',
        secret_id  TEXT,
        cred_type  TEXT NOT NULL DEFAULT 'api_key',
        status     TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, provider)
      );
      INSERT OR IGNORE INTO byok_user_credentials (user_id, provider, secret_id, cred_type, status, created_at, updated_at)
        SELECT user_id, provider, secret_id, cred_type, 'active',
               strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now')
          FROM byok_credentials
         WHERE status = 'active' AND secret_id IS NOT NULL
         GROUP BY user_id, provider;
    `);
  },
};
