/**
 * BYOK credential mapping (central DB). Stores only OneCLI ids + status — the
 * Anthropic key itself lives in the OneCLI vault. One row per (user, agent
 * group); the user's vault secret is reused across their agent-group rows.
 */
import { getDb } from '../../db/connection.js';
import { openToken, sealToken } from './crypto.js';

export type ByokStatus = 'active' | 'revoked';
export type ByokCredType = 'api_key' | 'oauth_token';

export interface ByokCredentialRow {
  user_id: string;
  agent_group_id: string;
  onecli_agent_id: string;
  secret_id: string | null;
  status: ByokStatus;
  cred_type: ByokCredType;
  oauth_token_enc: Buffer | null;
  oauth_token_nonce: Buffer | null;
  created_at: string;
  updated_at: string;
}

export function getByokCredential(userId: string, agentGroupId: string): ByokCredentialRow | null {
  return (
    (getDb()
      .prepare(`SELECT * FROM byok_credentials WHERE user_id = ? AND agent_group_id = ?`)
      .get(userId, agentGroupId) as ByokCredentialRow | undefined) ?? null
  );
}

/** True when the user has an active per-member key for this agent group. */
export function userHasActiveKey(userId: string, agentGroupId: string): boolean {
  return getByokCredential(userId, agentGroupId)?.status === 'active';
}

/** The user's existing vault secret id (reused across their agent-group rows), if any. */
export function getUserSecretId(userId: string): string | null {
  const row = getDb()
    .prepare(`SELECT secret_id FROM byok_credentials WHERE user_id = ? AND secret_id IS NOT NULL LIMIT 1`)
    .get(userId) as { secret_id: string } | undefined;
  return row?.secret_id ?? null;
}

/** Recover the owning agent group from a BYOK container's OneCLI identity (approval routing). */
export function agentGroupForByokAgent(onecliAgentId: string): string | null {
  const row = getDb()
    .prepare(`SELECT agent_group_id FROM byok_credentials WHERE onecli_agent_id = ? LIMIT 1`)
    .get(onecliAgentId) as { agent_group_id: string } | undefined;
  return row?.agent_group_id ?? null;
}

/** Active member user ids for an agent group (drives shared-context fan-out). */
export function activeMembersForGroup(agentGroupId: string): string[] {
  return (
    getDb()
      .prepare(`SELECT user_id FROM byok_credentials WHERE agent_group_id = ? AND status = 'active'`)
      .all(agentGroupId) as { user_id: string }[]
  ).map((r) => r.user_id);
}

export function upsertByokCredential(
  userId: string,
  agentGroupId: string,
  onecliAgentId: string,
  secretId: string | null,
): void {
  const now = new Date().toISOString();
  // API-key row: the key lives in the OneCLI vault; clear any OAuth blob so a
  // member switching oauth→api_key doesn't leave a stale encrypted token.
  getDb()
    .prepare(
      `INSERT INTO byok_credentials
         (user_id, agent_group_id, onecli_agent_id, secret_id, status, cred_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', 'api_key', ?, ?)
       ON CONFLICT (user_id, agent_group_id) DO UPDATE SET
         onecli_agent_id   = excluded.onecli_agent_id,
         secret_id         = excluded.secret_id,
         status            = 'active',
         cred_type         = 'api_key',
         oauth_token_enc   = NULL,
         oauth_token_nonce = NULL,
         updated_at        = excluded.updated_at`,
    )
    .run(userId, agentGroupId, onecliAgentId, secretId, now, now);
}

/**
 * OAuth row: the host stores the encrypted subscription token (OneCLI can't
 * carry it). `secret_id` is null — there is no Anthropic vault secret; the
 * per-member agent still exists (onecli_agent_id) for the group's tool secrets.
 */
export function upsertByokOauthCredential(
  userId: string,
  agentGroupId: string,
  onecliAgentId: string,
  token: string,
): void {
  const now = new Date().toISOString();
  const { enc, nonce } = sealToken(token);
  getDb()
    .prepare(
      `INSERT INTO byok_credentials
         (user_id, agent_group_id, onecli_agent_id, secret_id, status, cred_type,
          oauth_token_enc, oauth_token_nonce, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'active', 'oauth_token', ?, ?, ?, ?)
       ON CONFLICT (user_id, agent_group_id) DO UPDATE SET
         onecli_agent_id   = excluded.onecli_agent_id,
         secret_id         = NULL,
         status            = 'active',
         cred_type         = 'oauth_token',
         oauth_token_enc   = excluded.oauth_token_enc,
         oauth_token_nonce = excluded.oauth_token_nonce,
         updated_at        = excluded.updated_at`,
    )
    .run(userId, agentGroupId, onecliAgentId, enc, nonce, now, now);
}

/**
 * Decrypt the member's OAuth token for spawn-time env injection, or null if the
 * member has no active oauth_token row for this group. Never logged.
 */
export function getOauthToken(userId: string, agentGroupId: string): string | null {
  const row = getByokCredential(userId, agentGroupId);
  if (!row || row.status !== 'active' || row.cred_type !== 'oauth_token') return null;
  if (!row.oauth_token_enc || !row.oauth_token_nonce) return null;
  return openToken(row.oauth_token_enc, row.oauth_token_nonce);
}

/** Wipe the encrypted OAuth token (on revoke) so a stale blob never lingers. */
export function clearOauthToken(userId: string, agentGroupId: string): void {
  getDb()
    .prepare(
      `UPDATE byok_credentials SET oauth_token_enc = NULL, oauth_token_nonce = NULL, updated_at = ?
       WHERE user_id = ? AND agent_group_id = ?`,
    )
    .run(new Date().toISOString(), userId, agentGroupId);
}

export function setByokStatus(userId: string, agentGroupId: string, status: ByokStatus): void {
  getDb()
    .prepare(`UPDATE byok_credentials SET status = ?, updated_at = ? WHERE user_id = ? AND agent_group_id = ?`)
    .run(status, new Date().toISOString(), userId, agentGroupId);
}
