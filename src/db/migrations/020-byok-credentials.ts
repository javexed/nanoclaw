import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * BYOK per-member credential mapping (central DB).
 *
 * One row per (user, agent group) the user has connected an Anthropic key for.
 * We store only OneCLI ids + status here — never the key itself (that lives in
 * the OneCLI vault). `onecli_agent_id` is the per-member identity the container
 * spawns under; `secret_id` is the user's vault secret (reused across their
 * agent-group rows). The onecli_agent_id index lets approval routing recover
 * the owning agent group from a BYOK container's identity.
 */
export const migration020: Migration = {
  version: 20,
  name: 'byok-credentials',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS byok_credentials (
        user_id         TEXT NOT NULL,
        agent_group_id  TEXT NOT NULL,
        onecli_agent_id TEXT NOT NULL,
        secret_id       TEXT,
        status          TEXT NOT NULL DEFAULT 'active',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        PRIMARY KEY (user_id, agent_group_id)
      );
      CREATE INDEX IF NOT EXISTS idx_byok_onecli_agent ON byok_credentials(onecli_agent_id);
    `);
  },
};
