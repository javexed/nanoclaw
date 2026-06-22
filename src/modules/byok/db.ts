/**
 * BYOK credential mapping (central DB). Stores only OneCLI ids + status — the
 * Anthropic credential itself (API key OR subscription/OAuth token) lives in the
 * OneCLI vault. One row per (user, agent group); the user's vault secret is
 * reused across their agent-group rows.
 */
import { getDb } from '../../db/connection.js';

export type ByokStatus = 'active' | 'revoked';
export type ByokCredType = 'api_key' | 'oauth_token';

export interface ByokCredentialRow {
  user_id: string;
  agent_group_id: string;
  onecli_agent_id: string;
  secret_id: string | null;
  status: ByokStatus;
  cred_type: ByokCredType;
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

/** True when the user has an active per-member credential for this agent group. */
export function userHasActiveKey(userId: string, agentGroupId: string): boolean {
  return getByokCredential(userId, agentGroupId)?.status === 'active';
}

/**
 * True when the user's active credential is a subscription/OAuth token, so the
 * per-member container must be spawned in OAuth mode (sentinel
 * CLAUDE_CODE_OAUTH_TOKEN; the real token is swapped in by OneCLI on the wire).
 */
export function userHasActiveOauth(userId: string, agentGroupId: string): boolean {
  const row = getByokCredential(userId, agentGroupId);
  return row?.status === 'active' && row.cred_type === 'oauth_token';
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

/**
 * Upsert a member's credential row. Both API-key and OAuth credentials live in
 * the OneCLI vault, so both carry a `secret_id`; `credType` only records which
 * connect flow the member used (and gates OAuth-mode spawn).
 */
export function upsertByokCredential(
  userId: string,
  agentGroupId: string,
  onecliAgentId: string,
  secretId: string | null,
  credType: ByokCredType = 'api_key',
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO byok_credentials
         (user_id, agent_group_id, onecli_agent_id, secret_id, status, cred_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
       ON CONFLICT (user_id, agent_group_id) DO UPDATE SET
         onecli_agent_id = excluded.onecli_agent_id,
         secret_id       = excluded.secret_id,
         status          = 'active',
         cred_type       = excluded.cred_type,
         updated_at      = excluded.updated_at`,
    )
    .run(userId, agentGroupId, onecliAgentId, secretId, credType, now, now);
}

export function setByokStatus(userId: string, agentGroupId: string, status: ByokStatus): void {
  getDb()
    .prepare(`UPDATE byok_credentials SET status = ?, updated_at = ? WHERE user_id = ? AND agent_group_id = ?`)
    .run(status, new Date().toISOString(), userId, agentGroupId);
}
