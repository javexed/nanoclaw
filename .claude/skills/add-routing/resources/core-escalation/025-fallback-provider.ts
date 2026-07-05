import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Per-group fallback provider (llm-router design §16c).
 *
 * When set (e.g. 'claude'), the agent-runner re-runs a turn ONCE on this
 * provider after the primary provider fails terminally — the router's
 * `no_adequate_model` rejection and hard failures (backend down, timeout)
 * both land here. NULL (the default) means no escalation: errors surface to
 * the user as before.
 *
 * Guarded for re-runs: ALTER TABLE ADD COLUMN fails if the column exists.
 */
export const migration025: Migration = {
  version: 25,
  name: 'fallback-provider',
  up(db: Database.Database) {
    const cols = db.prepare(`PRAGMA table_info(container_configs)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'fallback_provider')) {
      db.exec(`ALTER TABLE container_configs ADD COLUMN fallback_provider TEXT`);
    }
  },
};
