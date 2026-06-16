/**
 * BYOK onboarding orchestration: connect/revoke a member's Anthropic key.
 *
 * The member's key lives in the OneCLI vault. Their per-(group,user) OneCLI
 * agent is assigned: their Anthropic secret PLUS the group's non-anthropic tool
 * secrets (mirrored at onboard time) — so a per-member container has the
 * member's key for Anthropic and the group's tools for everything else.
 *
 * Idempotent: re-onboarding updates the secret value and re-merges assignments.
 * The OneCLI calls go through an injectable OnecliAdmin (real CLI in prod, fake
 * in tests).
 */
import { log } from '../../log.js';
import { byokAgentIdentifier, userSlug } from './identity.js';
import {
  clearOauthToken,
  getByokCredential,
  getUserSecretId,
  setByokStatus,
  upsertByokCredential,
  upsertByokOauthCredential,
} from './db.js';
import type { OnecliAdmin } from './onecli-admin.js';

/**
 * The group's non-anthropic tool secret ids, to mirror onto a per-member agent
 * so its container keeps working tools (Gmail, GitHub, …) while its Anthropic
 * credential comes from the member (API key in the vault, or OAuth via env).
 */
async function groupToolSecretIds(admin: OnecliAdmin, agentGroupId: string): Promise<string[]> {
  const groupAgentUuid = await admin.findAgentId(agentGroupId);
  if (!groupAgentUuid) return [];
  const groupIds = await admin.listAgentSecretIds(groupAgentUuid);
  const typeById = new Map((await admin.listAllSecrets()).map((s) => [s.id, s.type]));
  return groupIds.filter((id) => typeById.get(id) !== 'anthropic');
}

export async function onboardByokCredential(
  admin: OnecliAdmin,
  userId: string,
  agentGroupId: string,
  displayName: string,
  apiKey: string,
): Promise<void> {
  // 1. The member's Anthropic secret — reuse across their groups; update on re-onboard.
  let secretId = getUserSecretId(userId);
  if (secretId) {
    await admin.updateSecretValue(secretId, apiKey);
  } else {
    secretId = await admin.createAnthropicSecret(`BYOK ${userSlug(userId)}`, apiKey);
  }

  // 2. The per-member OneCLI agent (the identity the container spawns under).
  const identifier = byokAgentIdentifier(agentGroupId, userId);
  const agentUuid = await admin.ensureAgent(`${displayName} (BYOK)`, identifier);
  await admin.setSecretMode(agentUuid, 'selective');

  // 3. Mirror the group's non-anthropic tool secrets + the member's Anthropic key.
  const toolSecretIds = await groupToolSecretIds(admin, agentGroupId);
  const merged = Array.from(new Set([secretId, ...toolSecretIds]));
  await admin.setSecrets(agentUuid, merged);

  // 4. Persist the mapping (identifier = the container's externalId for approval routing).
  upsertByokCredential(userId, agentGroupId, identifier, secretId);
  log.info('BYOK credential onboarded', { userId, agentGroupId, toolSecrets: toolSecretIds.length });
}

/**
 * OAuth (subscription) onboarding: connect a member's Claude `setup-token`.
 *
 * Unlike the API-key path, OneCLI cannot carry the token, so we do NOT create an
 * Anthropic vault secret. We still ensure the per-member OneCLI agent and mirror
 * the group's tool secrets onto it (the container keeps OneCLI for tools); the
 * Anthropic credential is injected as CLAUDE_CODE_OAUTH_TOKEN at spawn from the
 * host-encrypted store. The token is encrypted here and never logged.
 */
export async function onboardByokOauth(
  admin: OnecliAdmin,
  userId: string,
  agentGroupId: string,
  displayName: string,
  oauthToken: string,
): Promise<void> {
  const identifier = byokAgentIdentifier(agentGroupId, userId);
  const agentUuid = await admin.ensureAgent(`${displayName} (BYOK)`, identifier);
  await admin.setSecretMode(agentUuid, 'selective');

  // Tools only — no Anthropic secret. The OAuth token is host-side (env-injected).
  // OneCLI's `set-secrets` rejects an empty list (1.2.x: "expected array,
  // received null"), so skip it when the group has no tool secrets to mirror.
  // The Anthropic leg is NO_PROXY'd at spawn, so any secret OneCLI auto-assigned
  // to the fresh agent (e.g. the shared Anthropic key) is never injected.
  const toolSecretIds = await groupToolSecretIds(admin, agentGroupId);
  if (toolSecretIds.length > 0) await admin.setSecrets(agentUuid, toolSecretIds);

  upsertByokOauthCredential(userId, agentGroupId, identifier, oauthToken);
  log.info('BYOK OAuth credential onboarded', { userId, agentGroupId, toolSecrets: toolSecretIds.length });
}

export async function revokeByokCredential(admin: OnecliAdmin, userId: string, agentGroupId: string): Promise<void> {
  const row = getByokCredential(userId, agentGroupId);
  if (!row) return;
  // Remove the member's key from their per-member agent so it stops resolving
  // immediately (the agent itself can linger unused). Tool secrets are left.
  const agentUuid = await admin.findAgentId(row.onecli_agent_id);
  if (agentUuid && row.secret_id) {
    const remaining = (await admin.listAgentSecretIds(agentUuid)).filter((id) => id !== row.secret_id);
    // `set-secrets` can't take an empty list (see onboardByokOauth); if the
    // user's key was the only secret, mark the credential revoked in our DB
    // anyway — the per-member session no longer resolves, so the key stops
    // being used regardless of the lingering OneCLI assignment.
    if (remaining.length > 0) await admin.setSecrets(agentUuid, remaining);
  }
  // OAuth rows have no vault secret — the credential is the host-encrypted token;
  // wipe it so nothing lingers after revoke.
  if (row.cred_type === 'oauth_token') clearOauthToken(userId, agentGroupId);
  setByokStatus(userId, agentGroupId, 'revoked');
  log.info('BYOK credential revoked', { userId, agentGroupId, credType: row.cred_type });
}
