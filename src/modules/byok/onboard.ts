/**
 * BYOK onboarding orchestration — lazy / just-in-time.
 *
 * Two phases, so a member connects ONCE and it applies to every room:
 *
 *  1. storeUserCredential (at connect) — stash the member's credential as a
 *     single OneCLI vault secret + a user-level `byok_user_credentials` row.
 *     No per-room work. The host never holds the credential.
 *
 *  2. ensureGroupEnrollment (lazy, at first session spawn in a given room) —
 *     create the per-(user,group) OneCLI agent and assign the member's secret
 *     PLUS that group's other tool secrets, so the per-member container
 *     authenticates the model with the member's own credential (swapped in by
 *     OneCLI on the wire) and keeps the group's tools. Idempotent + skipped once
 *     enrolled, so it's a no-op on every spawn after the first.
 *
 * revokeUserCredential (at disconnect) tears both down everywhere.
 *
 * Provider-specific vault type: Claude → `anthropic` secret (sk-ant-api… or
 * sk-ant-oat…); Codex → `openai` secret (the whole ChatGPT/Codex auth.json for
 * OAuth, host chatgpt.com; or an OpenAI key, host api.openai.com).
 *
 * OneCLI calls go through an injectable OnecliAdmin (real CLI in prod, fake in tests).
 */
import { log } from '../../log.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { byokAgentIdentifier, userSlug } from './identity.js';
import {
  getByokCredential,
  getUserCredential,
  setByokStatus,
  setUserCredentialStatus,
  upsertByokCredential,
  upsertUserCredential,
  listEnrolledGroups,
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
 * Create the member's vault secret. Claude credentials — API key OR subscription
 * (OAuth) token — are stored as a single `anthropic`-type secret: OneCLI
 * auto-detects the auth mode from the value (an `sk-ant-oat…` token → `oauth`,
 * injected as `Authorization: Bearer …`; an `sk-ant-api…` key → `api-key`,
 * injected as `x-api-key`) and, either way, treats it as the api.anthropic.com
 * provider credential so the per-member agent passes the gateway's access gate.
 * (A `generic` secret on api.anthropic.com does NOT — the provider gate shadows
 * it.) Codex → an `openai` secret (auth.json via --file for OAuth, key via --value).
 */
async function createCredentialSecret(
  admin: OnecliAdmin,
  userId: string,
  provider: ByokProvider,
  credType: ByokCredType,
  credential: string,
): Promise<string> {
  const name = provider === 'codex' ? `BYOK ${userSlug(userId)} (codex)` : `BYOK ${userSlug(userId)}`;
  if (provider === 'codex') return admin.createOpenAISecret(name, credential, credType);
  return admin.createAnthropicSecret(name, credential);
}

/**
 * Un-assign the member's secret from every per-group agent it was lazily
 * enrolled on (for this provider) and mark those enrollments revoked. They
 * rebuild lazily on next use. Shared by disconnect and re-connect.
 */
async function unenrollGroups(admin: OnecliAdmin, userId: string, provider: ByokProvider): Promise<void> {
  for (const row of listEnrolledGroups(userId, provider)) {
    const agentUuid = await admin.findAgentId(row.onecli_agent_id);
    if (agentUuid && row.secret_id) {
      const remaining = (await admin.listAgentSecretIds(agentUuid)).filter((id) => id !== row.secret_id);
      // `set-secrets` can't take an empty list; the revoke below stops the
      // per-member session resolving regardless of a lingering assignment.
      if (remaining.length > 0) await admin.setSecrets(agentUuid, remaining);
    }
    setByokStatus(userId, row.agent_group_id, 'revoked');
  }
}

/**
 * Phase 1 (connect): stash the member's credential as a single vault secret +
 * the user-level row. No per-room work beyond tearing down any prior secret.
 * `provider` is the connecting room's provider; `credType` (api_key |
 * oauth_token) is recorded for display + spawn mode.
 *
 * The secret's wire injection (x-api-key vs Authorization: Bearer) is baked in
 * at create time and OneCLI can't change it in place, so a re-connect deletes
 * the old secret and creates a fresh one. Any lazy per-room enrollments are
 * torn down first and rebuild on next use with the new secret id.
 */
export async function storeUserCredential(
  admin: OnecliAdmin,
  userId: string,
  provider: ByokProvider,
  credential: string,
  credType: ByokCredType,
): Promise<void> {
  const prior = getUserCredential(userId, provider);
  if (prior?.secret_id) {
    await unenrollGroups(admin, userId, provider);
    await admin.deleteSecret(prior.secret_id).catch(() => {}); // best-effort; orphan is harmless
  }
  const secretId = await createCredentialSecret(admin, userId, provider, credType, credential);
  upsertUserCredential(userId, provider, secretId, credType);
  log.info('BYOK credential stored', { userId, provider, credType });
}

/**
 * Phase 2 (lazy, at first session spawn in a room): create the per-(user,group)
 * OneCLI agent and assign the member's secret + that group's tool secrets.
 * Idempotent — returns immediately if already enrolled, or if the member hasn't
 * connected a credential for this group's provider.
 */
export async function ensureGroupEnrollment(admin: OnecliAdmin, userId: string, agentGroupId: string): Promise<void> {
  const provider = groupProvider(agentGroupId);
  // Already enrolled — but only skip when the enrollment is for THIS group's
  // CURRENT provider. If the group's provider was switched after enrollment, the
  // stale row would otherwise pin the wrong secret; fall through to re-enroll.
  const existing = getByokCredential(userId, agentGroupId);
  if (existing?.status === 'active' && existing.provider === provider) return;
  const userCred = getUserCredential(userId, provider);
  if (userCred?.status !== 'active' || !userCred.secret_id) return; // not connected — nothing to enroll
  const secretId = userCred.secret_id;

  const identifier = byokAgentIdentifier(agentGroupId, userId);
  const agentUuid = await admin.ensureAgent(`${userSlug(userId)} (BYOK)`, identifier);
  await admin.setSecretMode(agentUuid, 'selective');
  const toolSecretIds = await groupToolSecretIds(admin, agentGroupId, secretTypeFor(provider));
  const merged = Array.from(new Set([secretId, ...toolSecretIds]));
  await admin.setSecrets(agentUuid, merged);
  upsertByokCredential(userId, agentGroupId, identifier, secretId, userCred.cred_type, provider);
  log.info('BYOK group enrolled (lazy)', { userId, agentGroupId, provider, toolSecrets: toolSecretIds.length });
}

/**
 * Disconnect: un-assign the member secret from every per-group agent it was
 * lazily enrolled on, DELETE the user-level vault secret (so the member's real
 * credential actually leaves the vault — not just marked revoked — which also
 * neutralizes any lingering assignment OneCLI couldn't clear via an empty
 * set-secrets), then mark the rows revoked.
 */
export async function revokeUserCredential(admin: OnecliAdmin, userId: string, provider: ByokProvider): Promise<void> {
  await unenrollGroups(admin, userId, provider);
  const secretId = getUserCredential(userId, provider)?.secret_id ?? null;
  if (secretId) await admin.deleteSecret(secretId).catch(() => {}); // best-effort; row revoke below is the gate
  setUserCredentialStatus(userId, provider, 'revoked');
  log.info('BYOK credential revoked', { userId, provider });
}
