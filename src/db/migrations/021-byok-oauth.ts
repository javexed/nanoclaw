import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * OAuth (subscription) BYOK — adds the credential-type discriminator and the
 * host-side encrypted token store to `byok_credentials`.
 *
 * `cred_type`:
 *   'api_key'     — the member's key lives in the OneCLI vault (secret_id set);
 *                   the host never holds it. (default; existing rows.)
 *   'oauth_token' — a Claude subscription token from `claude setup-token`.
 *                   OneCLI can't carry it (no refresh, can't put the SDK in
 *                   OAuth mode), so the host stores it encrypted here and
 *                   injects CLAUDE_CODE_OAUTH_TOKEN into the per-member
 *                   container at spawn. secret_id is null for these rows.
 *
 * `oauth_token_enc` / `oauth_token_nonce` — AES-256-GCM ciphertext (incl. the
 * 16-byte GCM tag appended) + nonce, keyed by a host-local 0600 keyfile. Null
 * for api_key rows. See src/modules/byok/crypto.ts and docs/design/byok-oauth.md.
 */
export const migration021: Migration = {
  version: 21,
  name: 'byok-oauth-credentials',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE byok_credentials ADD COLUMN cred_type TEXT NOT NULL DEFAULT 'api_key';
      ALTER TABLE byok_credentials ADD COLUMN oauth_token_enc BLOB;
      ALTER TABLE byok_credentials ADD COLUMN oauth_token_nonce BLOB;
    `);
  },
};
