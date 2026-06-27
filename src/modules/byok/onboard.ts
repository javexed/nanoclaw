/**
 * BYOK onboarding orchestration: connect/revoke a member's model credential.
 *
 * The member's credential — an API key OR a subscription/OAuth token — lives in
 * the OneCLI vault. Which vault type it takes is provider-specific: a Claude room
 * (`container_configs.provider != 'codex'`) stores an `anthropic` secret; a Codex
 * room stores an `openai` secret (the member's ChatGPT/Codex `auth.json` for
 * OAuth, or an OpenAI key). Their per-(group,user) OneCLI agent is assigned that
 * secret PLUS the group's other tool secrets (mirrored at onboard time) — so a
 * per-member container authenticates the model with the member's own credential
 * (swapped in by OneCLI on the wire) and the group's tools for everything else.
 * The host never holds the credential.
 *
 * Idempotent: re-onboarding updates the secret value and re-merges assignments.
 * The OneCLI calls go through an injectable OnecliAdmin (real CLI in prod, fake
 * in tests).
 */
import { log } from '../../log.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { byokAgentIdentifier, userSlug } from './identity.js';
import {
  getByokCredential,
  getUserSecretId,
  setByokStatus,
  upsertByokCredential,
  type ByokCredType,
  type ByokProvider,
} from './db.js';
import type { OnecliAdmin } from './onecli-admin.js';

/** The agent group's provider, mapped to the two BYOK-supported families. */
function groupProvider(agentGroupId: string): ByokProvider {
  return getContainerConfig(agentGroupId)?.provider === 'codex' ? 'codex' : 'claude';
}

/** The vault secret type that holds a member's credential for a provider. */
function secretTypeFor(provider: ByokProvider): 'anthropic' | 'openai' {
  return provider === 'codex' ? 'openai' : 'anthropic';
}

/**
 * The group's tool secret ids EXCLUDING the member-supplied credential type, to
 * mirror onto a per-member agent so its container keeps working tools (Gmail,
 * GitHub, …) while its model credential (Anthropic for Claude, OpenAI for Codex)
 * comes from the member.
 */
async function groupToolSecretIds(admin: OnecliAdmin, agentGroupId: string, credSecretType: string): Promise<string[]> {
  const groupAgentUuid = await admin.findAgentId(agentGroupId);
  if (!groupAgentUuid) return [];
  const groupIds = await admin.listAgentSecretIds(groupAgentUuid);
  const typeById = new Map((await admin.listAllSecrets()).map((s) => [s.id, s.type]));
  return groupIds.filter((id) => typeById.get(id) !== credSecretType);
}

/**
 * Shared onboarding for both credential kinds across both providers. `credType`
 * (api_key | oauth_token) is recorded for display + spawn mode; the group's
 * provider decides the vault secret type and how the value is stored:
 *
 *   Claude → `anthropic` secret (accepts both `sk-ant-api…` and `sk-ant-oat…`,
 *            same as setup/register-claude-token.sh); swapped in on the wire.
 *   Codex  → `openai` secret. OAuth stores the whole ChatGPT/Codex `auth.json`
 *            (host chatgpt.com); API key stores the key (host api.openai.com).
 *            OneCLI's gateway serves it as the sentinel auth.json stub.
 */
async function onboardSecret(
  admin: OnecliAdmin,
  userId: string,
  agentGroupId: string,
  displayName: string,
  credential: string,
  credType: ByokCredType,
): Promise<void> {
  const provider = groupProvider(agentGroupId);
  const credSecretType = secretTypeFor(provider);
  // Codex OAuth credentials are the whole auth.json → stored via --file.
  const asFile = provider === 'codex' && credType === 'oauth_token';

  // 1. The member's model secret for this provider — reuse across their
  //    same-provider groups; update on re-onboard.
  let secretId = getUserSecretId(userId, provider);
  if (secretId) {
    await admin.updateSecretValue(secretId, credential, asFile);
  } else {
    const name = provider === 'codex' ? `BYOK ${userSlug(userId)} (codex)` : `BYOK ${userSlug(userId)}`;
    secretId =
      provider === 'codex'
        ? await admin.createOpenAISecret(name, credential, credType)
        : await admin.createAnthropicSecret(name, credential);
  }

  // 2. The per-member OneCLI agent (the identity the container spawns under).
  const identifier = byokAgentIdentifier(agentGroupId, userId);
  const agentUuid = await admin.ensureAgent(`${displayName} (BYOK)`, identifier);
  await admin.setSecretMode(agentUuid, 'selective');

  // 3. Mirror the group's other tool secrets + the member's model secret.
  const toolSecretIds = await groupToolSecretIds(admin, agentGroupId, credSecretType);
  const merged = Array.from(new Set([secretId, ...toolSecretIds]));
  await admin.setSecrets(agentUuid, merged);

  // 4. Persist the mapping (identifier = the container's externalId for approval routing).
  upsertByokCredential(userId, agentGroupId, identifier, secretId, credType, provider);
  log.info('BYOK credential onboarded', {
    userId,
    agentGroupId,
    provider,
    credType,
    toolSecrets: toolSecretIds.length,
  });
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
 * OAuth (subscription) onboarding: connect a member's subscription credential —
 * a Claude `setup-token` for a Claude room, or a ChatGPT/Codex `auth.json` for a
 * Codex room. The value lives in the OneCLI vault and is swapped in on the wire.
 * cred_type='oauth_token' drives spawn mode: a Claude room gets the sentinel
 * CLAUDE_CODE_OAUTH_TOKEN; a Codex room needs no env (auth rides the gateway
 * auth.json stub). See src/modules/byok/index.ts.
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
