import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Rename the BYOK tables to the user-facing "user credentials" terminology.
 *
 * Migrations 020–023 created `byok_credentials` (per-member session mapping) and
 * `byok_user_credentials` (per-user connect-time source of truth). The feature is
 * now called "user credentials" everywhere (UI + code), so this renames the
 * tables to match the code, which references the new names. The old migrations
 * are left untouched (their recorded names in `schema_version` must not change);
 * on a fresh install they create the `byok_*` tables and this migration renames
 * them in the same startup pass.
 *
 * Guarded so it's a no-op if already renamed (e.g. a partial re-run) and safe on
 * a DB that never had the BYOK tables.
 */
export const migration024: Migration = {
  version: 24,
  name: 'rename-user-credentials',
  up(db: Database.Database) {
    const hasTable = (t: string) =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t) != null;
    const hasIndex = (i: string) =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name = ?").get(i) != null;

    if (hasTable('byok_user_credentials') && !hasTable('user_credentials')) {
      db.exec('ALTER TABLE byok_user_credentials RENAME TO user_credentials;');
    }
    if (hasTable('byok_credentials') && !hasTable('user_credential_members')) {
      db.exec('ALTER TABLE byok_credentials RENAME TO user_credential_members;');
    }
    // The onecli-agent index keeps its byok name after a table rename; rename it
    // too so no "byok" remains in the schema. No code references the index name.
    if (hasIndex('idx_byok_onecli_agent')) {
      db.exec('DROP INDEX idx_byok_onecli_agent;');
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_user_credential_members_onecli_agent ON user_credential_members(onecli_agent_id);',
      );
    }
  },
};
