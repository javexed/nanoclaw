import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * BYOK per-member provider.
 *
 * A member's credential is provider-specific: a Claude room stores an
 * `anthropic` vault secret, a Codex room stores an `openai` secret (the
 * member's ChatGPT/Codex `auth.json` or OpenAI key). The provider is determined
 * by the agent group's `container_configs.provider` at onboard time and pinned
 * here so secret-reuse (`getUserSecretId`) stays scoped to the same provider —
 * a member in BOTH a Claude room and a Codex room needs two distinct secrets —
 * and so the per-member spawn knows whether to inject the Claude OAuth sentinel
 * (`provider='claude'` only; Codex auth rides OneCLI's gateway auth.json stub,
 * no env var). Existing rows predate Codex BYOK, so default to 'claude'.
 */
export const migration022: Migration = {
  version: 22,
  name: 'byok-provider',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE byok_credentials ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';`);
  },
};
