/**
 * UserCreds credential mapping (central DB). Stores only OneCLI ids + status — the
 * Anthropic credential itself (API key OR subscription/OAuth token) lives in the
 * OneCLI vault. One row per (user, agent group); the user's vault secret is
 * reused across their agent-group rows.
 */
import { getDb } from '../../db/connection.js';

export type UserCredsStatus = 'active' | 'revoked';
export type UserCredsCredType = 'api_key' | 'oauth_token';
/**
 * Which agent provider this credential is for — pinned from the group's
 * `container_configs.provider` at onboard time. 'claude' → `anthropic` vault
 * secret; 'codex' → `openai` secret (the member's ChatGPT/Codex auth.json or
 * OpenAI key). Drives secret-reuse scoping and Claude-OAuth-sentinel injection.
 */
export type UserCredsProvider = 'claude' | 'codex';

export interface UserCredsCredentialRow {
  user_id: string;
  agent_group_id: string;
  onecli_agent_id: string;
  secret_id: string | null;
  status: UserCredsStatus;
  cred_type: UserCredsCredType;
  provider: UserCredsProvider;
  created_at: string;
  updated_at: string;
}

export function getUserCredsCredential(userId: string, agentGroupId: string): UserCredsCredentialRow | null {
  return (
    (getDb()
      .prepare(`SELECT * FROM user_credential_members WHERE user_id = ? AND agent_group_id = ?`)
      .get(userId, agentGroupId) as UserCredsCredentialRow | undefined) ?? null
  );
}

/** True when the user has an active per-member credential for this agent group. */
export function userHasActiveKey(userId: string, agentGroupId: string): boolean {
  return getUserCredsCredential(userId, agentGroupId)?.status === 'active';
}

/**
 * True when the user's active credential is a *Claude* subscription/OAuth token,
 * so the per-member container must be spawned in OAuth mode (sentinel
 * CLAUDE_CODE_OAUTH_TOKEN; the real token is swapped in by OneCLI on the wire).
 * Codex OAuth is deliberately excluded — Codex auth rides OneCLI's gateway
 * auth.json stub (no env var), so a Codex member needs no sentinel.
 */
export function userHasActiveOauth(userId: string, agentGroupId: string): boolean {
  const row = getUserCredsCredential(userId, agentGroupId);
  return row?.status === 'active' && row.cred_type === 'oauth_token' && row.provider === 'claude';
}

// ── User-level credential (connect-time source of truth) ──
// One row per (user, provider): the single vault secret the member connected.
// Per-group enrollment (above) is created lazily from this on first use.
export interface UserCredsUserCredentialRow {
  user_id: string;
  provider: UserCredsProvider;
  secret_id: string | null;
  cred_type: UserCredsCredType;
  status: UserCredsStatus;
  created_at: string;
  updated_at: string;
}

export function getUserCredential(userId: string, provider: UserCredsProvider): UserCredsUserCredentialRow | null {
  return (
    (getDb().prepare(`SELECT * FROM user_credentials WHERE user_id = ? AND provider = ?`).get(userId, provider) as
      | UserCredsUserCredentialRow
      | undefined) ?? null
  );
}

/** True when the user has connected a credential for this provider (the gate for per-member routing). */
export function userHasConnectedCredential(userId: string, provider: UserCredsProvider): boolean {
  return getUserCredential(userId, provider)?.status === 'active';
}

/** The user's vault secret id for a provider — now sourced from the user-level credential. */
export function getUserSecretId(userId: string, provider: UserCredsProvider = 'claude'): string | null {
  const row = getUserCredential(userId, provider);
  return row && row.status === 'active' ? (row.secret_id ?? null) : null;
}

export function upsertUserCredential(
  userId: string,
  provider: UserCredsProvider,
  secretId: string | null,
  credType: UserCredsCredType,
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO user_credentials (user_id, provider, secret_id, cred_type, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)
       ON CONFLICT (user_id, provider) DO UPDATE SET
         secret_id  = excluded.secret_id,
         cred_type  = excluded.cred_type,
         status     = 'active',
         updated_at = excluded.updated_at`,
    )
    .run(userId, provider, secretId, credType, now, now);
}

export function setUserCredentialStatus(userId: string, provider: UserCredsProvider, status: UserCredsStatus): void {
  getDb()
    .prepare(`UPDATE user_credentials SET status = ?, updated_at = ? WHERE user_id = ? AND provider = ?`)
    .run(status, new Date().toISOString(), userId, provider);
}

/** Per-group enrollment rows for a user+provider — used to revoke everywhere on disconnect. */
export function listEnrolledGroups(userId: string, provider: UserCredsProvider): UserCredsCredentialRow[] {
  return getDb()
    .prepare(`SELECT * FROM user_credential_members WHERE user_id = ? AND provider = ? AND status = 'active'`)
    .all(userId, provider) as UserCredsCredentialRow[];
}

/** Recover the owning agent group from a UserCreds container's OneCLI identity (approval routing). */
export function agentGroupForUserCredsAgent(onecliAgentId: string): string | null {
  const row = getDb()
    .prepare(`SELECT agent_group_id FROM user_credential_members WHERE onecli_agent_id = ? LIMIT 1`)
    .get(onecliAgentId) as { agent_group_id: string } | undefined;
  return row?.agent_group_id ?? null;
}

/** Active member user ids for an agent group (drives shared-context fan-out). */
export function activeMembersForGroup(agentGroupId: string): string[] {
  return (
    getDb()
      .prepare(`SELECT user_id FROM user_credential_members WHERE agent_group_id = ? AND status = 'active'`)
      .all(agentGroupId) as { user_id: string }[]
  ).map((r) => r.user_id);
}

/**
 * Upsert a member's credential row. Both API-key and OAuth credentials live in
 * the OneCLI vault, so both carry a `secret_id`; `credType` only records which
 * connect flow the member used (and gates OAuth-mode spawn).
 */
export function upsertUserCredsCredential(
  userId: string,
  agentGroupId: string,
  onecliAgentId: string,
  secretId: string | null,
  credType: UserCredsCredType = 'api_key',
  provider: UserCredsProvider = 'claude',
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO user_credential_members
         (user_id, agent_group_id, onecli_agent_id, secret_id, status, cred_type, provider, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
       ON CONFLICT (user_id, agent_group_id) DO UPDATE SET
         onecli_agent_id = excluded.onecli_agent_id,
         secret_id       = excluded.secret_id,
         status          = 'active',
         cred_type       = excluded.cred_type,
         provider        = excluded.provider,
         updated_at      = excluded.updated_at`,
    )
    .run(userId, agentGroupId, onecliAgentId, secretId, credType, provider, now, now);
}

export function setUserCredsStatus(userId: string, agentGroupId: string, status: UserCredsStatus): void {
  getDb()
    .prepare(`UPDATE user_credential_members SET status = ?, updated_at = ? WHERE user_id = ? AND agent_group_id = ?`)
    .run(status, new Date().toISOString(), userId, agentGroupId);
}
