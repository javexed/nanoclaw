/**
 * UserCreds identity helpers.
 *
 * A per-member webchat session runs in a container bearing a per-(user, agent
 * group) OneCLI agent identity, so the gateway injects THAT user's Anthropic
 * key (plus the group's other tool secrets) based on the identity it trusts at
 * spawn. There is no per-turn token to replay.
 *
 * OneCLI agent identifiers must be lowercase `[a-z0-9-]` — so we can't embed
 * the raw user id (which contains `:`/`@`) or split a composite on `:`. The
 * identifier is `user-creds-<userSlug>-<hash>`; the host recovers the owning agent
 * group via the `user_credential_members` table (onecli_agent_id → agent_group_id),
 * not by parsing the identifier.
 */
import crypto from 'crypto';

const ID_PREFIX = 'user-creds-';

/** A readable, valid-charset slug of a namespaced user id (e.g. `webchat:tailscale:a@x.com`). */
export function userSlug(userId: string): string {
  const base = userId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
  return base || 'user';
}

/**
 * Deterministic, collision-resistant, valid OneCLI identifier for a
 * (agent group, user) pair. Same input → same identifier (idempotent
 * onboarding + spawn must agree).
 */
export function userCredsAgentIdentifier(agentGroupId: string, userId: string): string {
  const hash = crypto.createHash('sha256').update(`${agentGroupId}|${userId}`).digest('hex').slice(0, 12);
  return `${ID_PREFIX}${userSlug(userId)}-${hash}`;
}

/** True if an OneCLI identifier was minted for a UserCreds per-member agent. */
export function isUserCredsAgentIdentifier(identifier: string | null | undefined): boolean {
  return typeof identifier === 'string' && identifier.startsWith(ID_PREFIX);
}
