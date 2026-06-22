/**
 * BYOK onboarding orchestration: connect/revoke a member's Anthropic credential.
 *
 * The member's credential — an API key OR a Claude subscription/OAuth token —
 * lives in the OneCLI vault. Their per-(group,user) OneCLI agent is assigned:
 * their Anthropic secret PLUS the group's non-anthropic tool secrets (mirrored
 * at onboard time) — so a per-member container authenticates Anthropic with the
 * member's own credential (swapped in by OneCLI on the wire) and the group's
 * tools for everything else. The host never holds the credential.
 *
 * Idempotent: re-onboarding updates the secret value and re-merges assignments.
 * The OneCLI calls go through an injectable OnecliAdmin (real CLI in prod, fake
 * in tests).
 */
import { log } from '../../log.js';
import { byokAgentIdentifier, userSlug } from './identity.js';
import { getByokCredential, getUserSecretId, setByokStatus, upsertByokCredential, type ByokCredType } from './db.js';
import type { OnecliAdmin } from './onecli-admin.js';

/**
 * The group's non-anthropic tool secret ids, to mirror onto a per-member agent
 * so its container keeps working tools (Gmail, GitHub, …) while its Anthropic
 * credential comes from the member.
 */
async function groupToolSecretIds(admin: OnecliAdmin, agentGroupId: string): Promise<string[]> {
  const groupAgentUuid = await admin.findAgentId(agentGroupId);
  if (!groupAgentUuid) return [];
  const groupIds = await admin.listAgentSecretIds(groupAgentUuid);
  const typeById = new Map((await admin.listAllSecrets()).map((s) => [s.id, s.type]));
  return groupIds.filter((id) => typeById.get(id) !== 'anthropic');
}

/**
 * Shared onboarding for both credential kinds. The only difference between an
 * API key and an OAuth/subscription token is `credType` (recorded for display +
 * OAuth-mode spawn) — both are stored as the member's Anthropic vault secret and
 * swapped in by OneCLI on the wire. OneCLI's `anthropic` secret type accepts
 * both `sk-ant-api…` and `sk-ant-oat…` values (the operator subscription flow
 * in setup/register-claude-token.sh uses the same `--type anthropic`).
 */
async function onboardSecret(
  admin: OnecliAdmin,
  userId: string,
  agentGroupId: string,
  displayName: string,
  credential: string,
  credType: ByokCredType,
): Promise<void> {
  // 1. The member's Anthropic secret — reuse across their groups; update on re-onboard.
  let secretId = getUserSecretId(userId);
  if (secretId) {
    await admin.updateSecretValue(secretId, credential);
  } else {
    secretId = await admin.createAnthropicSecret(`BYOK ${userSlug(userId)}`, credential);
  }

  // 2. The per-member OneCLI agent (the identity the container spawns under).
  const identifier = byokAgentIdentifier(agentGroupId, userId);
  const agentUuid = await admin.ensureAgent(`${displayName} (BYOK)`, identifier);
  await admin.setSecretMode(agentUuid, 'selective');

  // 3. Mirror the group's non-anthropic tool secrets + the member's Anthropic secret.
  const toolSecretIds = await groupToolSecretIds(admin, agentGroupId);
  const merged = Array.from(new Set([secretId, ...toolSecretIds]));
  await admin.setSecrets(agentUuid, merged);

  // 4. Persist the mapping (identifier = the container's externalId for approval routing).
  upsertByokCredential(userId, agentGroupId, identifier, secretId, credType);
  log.info('BYOK credential onboarded', { userId, agentGroupId, credType, toolSecrets: toolSecretIds.length });
}

export function onboardByokCredential(
  admin: OnecliAdmin,
  userId: string,
  agentGroupId: string,
  displayName: string,
  apiKey: string,
): Promise<void> {
  return onboardSecret(admin, userId, agentGroupId, displayName, apiKey, 'api_key');
}

/**
 * OAuth (subscription) onboarding: connect a member's Claude `setup-token`.
 *
 * Identical to the API-key path — the token lives in the OneCLI vault and is
 * swapped in on the wire — except cred_type='oauth_token', which puts the
 * per-member container in OAuth mode at spawn (sentinel CLAUDE_CODE_OAUTH_TOKEN,
 * routed through OneCLI; see src/modules/byok/index.ts).
 */
export function onboardByokOauth(
  admin: OnecliAdmin,
  userId: string,
  agentGroupId: string,
  displayName: string,
  oauthToken: string,
): Promise<void> {
  return onboardSecret(admin, userId, agentGroupId, displayName, oauthToken, 'oauth_token');
}

export async function revokeByokCredential(admin: OnecliAdmin, userId: string, agentGroupId: string): Promise<void> {
  const row = getByokCredential(userId, agentGroupId);
  if (!row) return;
  // Remove the member's credential from their per-member agent so it stops
  // resolving immediately (the agent itself can linger unused). Tool secrets
  // are left. Applies to both API-key and OAuth rows — both are vault secrets.
  const agentUuid = await admin.findAgentId(row.onecli_agent_id);
  if (agentUuid && row.secret_id) {
    const remaining = (await admin.listAgentSecretIds(agentUuid)).filter((id) => id !== row.secret_id);
    // `set-secrets` can't take an empty list; if the member's secret was the
    // only one, mark the credential revoked in our DB anyway — the per-member
    // session no longer resolves, so the credential stops being used regardless
    // of the lingering OneCLI assignment.
    if (remaining.length > 0) await admin.setSecrets(agentUuid, remaining);
  }
  setByokStatus(userId, agentGroupId, 'revoked');
  log.info('BYOK credential revoked', { userId, agentGroupId, credType: row.cred_type });
}
