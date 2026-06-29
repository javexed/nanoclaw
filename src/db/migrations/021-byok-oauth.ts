import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * OAuth (subscription) BYOK — adds the credential-type discriminator to
 * `byok_credentials`.
 *
 * `cred_type`:
 *   'api_key'     — the member connected an `sk-ant-api…` key.
 *   'oauth_token' — the member connected a Claude subscription token from
 *                   `claude setup-token` (`sk-ant-oat…`).
 *
 * Both kinds live in the OneCLI vault (secret_id set) — the host never holds
 * the credential. cred_type only drives presentation (which connect flow the
 * member used) and whether the per-member container is put in OAuth mode (a
 * sentinel CLAUDE_CODE_OAUTH_TOKEN at spawn; OneCLI swaps the real token on the
 * wire). See src/modules/byok/index.ts and docs/design/byok-oauth.md.
 */
export const migration021: Migration = {
  version: 21,
  name: 'byok-oauth-credentials',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE byok_credentials ADD COLUMN cred_type TEXT NOT NULL DEFAULT 'api_key';
    `);
  },
};
