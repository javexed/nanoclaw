/**
 * UserCreds module — secure shared-room bring-your-own-key.
 *
 * Self-registers a session-key resolver so that, in a webchat room opted into
 * a non-disabled credential mode, a member who has connected their own
 * Anthropic key gets their OWN per-member session (keyed by userId). That
 * session's container spawns under the member's OneCLI identity, so the
 * gateway injects their key — no shared per-turn token, nothing to replay.
 *
 * Imported for side effects by src/modules/index.js (added by the installer).
 */
import { registerSessionKeyResolver, registerPerMemberInboundWriter } from '../../session-manager.js';
import {
  registerAgentIdentityResolver,
  registerContainerEnvResolver,
  registerSessionPrepareHook,
} from '../../container-runtime.js';
import { writeMemberTranscript } from './fanout.js';
import { getDb, hasTable } from '../../db/connection.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { registerApprovalAgentGroupFallback } from '../approvals/onecli-approvals.js';
import { getEffectiveRoomMode, getCredentialsConfig } from '../../channels/webchat/db.js';
import {
  userHasConnectedCredential,
  getUserCredential,
  agentGroupForUserCredsAgent,
  type UserCredsProvider,
} from './db.js';
import { ensureGroupEnrollment } from './onboard.js';
import { realOnecliAdmin } from './onecli-admin.js';
import { userCredsAgentIdentifier } from './identity.js';

/** The agent group's provider, mapped to the two UserCreds-supported families. */
function groupProvider(agentGroupId: string): UserCredsProvider {
  return getContainerConfig(agentGroupId)?.provider === 'codex' ? 'codex' : 'claude';
}

// Sentinel bearer for a per-member OAuth container. Its value is irrelevant
// beyond being non-empty: it flips Claude Code into OAuth mode (so it sends
// `Authorization: Bearer <sentinel>` + the oauth beta header), and OneCLI
// overwrites it on the wire with the member's real vault token. Mirrors the
// host-side drafter (src/channels/webchat/drafter.ts).
const OAUTH_SENTINEL = 'placeholder';

registerSessionKeyResolver((mg, agentGroupId, userId) => {
  // UserCreds is webchat-only and opt-in per room. Fail safe to no override.
  if (mg.channel_type !== 'webchat' || !userId) return null;
  if (!hasTable(getDb(), 'webchat_room_settings')) return null;
  // Effective mode = the room's override, else the global default. Which
  // credential TYPES the workspace accepts (key / OAuth, per provider) is set on
  // the Credentials admin page; the room's mode is the master switch over both.
  const provider = groupProvider(agentGroupId);
  const cfg = getCredentialsConfig();
  const mode = getEffectiveRoomMode(mg.platform_id);
  // 'disabled' (User credentials: Off) means no UserCreds at all — neither key nor
  // OAuth — regardless of what the workspace accepts. Otherwise each method
  // applies if the workspace accepts it for this provider.
  const apiOffered = mode !== 'disabled' && (provider === 'codex' ? cfg.allowOpenaiKey : cfg.allowAnthropicKey);
  const oauthOffered = mode !== 'disabled' && (provider === 'codex' ? cfg.allowCodexOauth : cfg.allowClaudeOauth);
  if (!apiOffered && !oauthOffered) return null; // UserCreds entirely off here.

  // A member gets their own per-member session ONLY if their connected credential
  // is still PERMITTED by current policy — so flipping an allowance off (or a
  // room to disabled) stops already-connected members routing, not just new ones.
  // The per-(user,group) OneCLI agent is created lazily at spawn (prepare hook).
  const cred = getUserCredential(userId, provider);
  if (cred?.status === 'active') {
    const permitted = cred.cred_type === 'oauth_token' ? oauthOffered : apiOffered;
    if (permitted) return { sessionMode: 'per-thread', threadId: userId };
  }
  // No permitted credential: API-key 'required' rooms decline with guidance;
  // otherwise (optional, or OAuth-only) fall back to the shared session.
  if (mode === 'required') {
    const credName = provider === 'codex' ? 'Codex credential' : 'Anthropic key';
    return { block: `This room requires your own ${credName} — connect it in the banner above the chat.` };
  }
  return null;
});

// A per-member session (thread_id = userId) whose member has connected a
// credential for this room's provider spawns under the member's own OneCLI
// identity → gateway injects THEIR credential. The agent itself is created by
// the prepare hook below (which runs first), so this just names it.
registerAgentIdentityResolver((agentGroupId, threadId) => {
  if (threadId && userHasConnectedCredential(threadId, groupProvider(agentGroupId))) {
    return userCredsAgentIdentifier(agentGroupId, threadId);
  }
  return null;
});

// Lazy / just-in-time enrollment: the first time a connected member's session is
// spawned in a room, create their per-(user,group) OneCLI agent and assign their
// secret + the group's tool secrets. Runs before identity resolution. Idempotent
// + a fast no-op once enrolled, so it costs nothing on subsequent spawns.
registerSessionPrepareHook(async (agentGroupId, threadId) => {
  if (!threadId || !userHasConnectedCredential(threadId, groupProvider(agentGroupId))) return;
  await ensureGroupEnrollment(realOnecliAdmin, threadId, agentGroupId);
});

// Claude OAuth members: put their per-member container in subscription/OAuth mode
// with a SENTINEL token and route Anthropic THROUGH OneCLI — OneCLI swaps the
// sentinel for the member's real token (a `generic` vault secret injected as
// `Authorization: Bearer …`). The real token never enters the container.
//
// Crucially we also BLANK `ANTHROPIC_API_KEY`: the OneCLI gateway sets it to
// `placeholder` on every agent so api-key agents send `x-api-key` for the
// gateway to overwrite. But an OAuth member's secret rewrites `Authorization`,
// not `x-api-key`, so a lingering `x-api-key: placeholder` would reach Anthropic
// and be rejected ("invalid API key"). Blanking it makes Claude Code use pure
// OAuth mode — `Authorization: Bearer` + the oauth beta header, no x-api-key.
// extraEnv is applied AFTER the gateway env, so this override wins.
//
// API-key members get {} (their key rides x-api-key, which the gateway swaps).
// Codex members get {}: gated on the Claude provider; Codex auth rides OneCLI's
// gateway auth.json stub (keyed by the per-member identity) — no env var.
registerContainerEnvResolver((agentGroupId, threadId): Record<string, string> => {
  if (!threadId || groupProvider(agentGroupId) !== 'claude') return {};
  const cred = getUserCredential(threadId, 'claude');
  if (cred?.status !== 'active' || cred.cred_type !== 'oauth_token') return {};
  return { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_SENTINEL, ANTHROPIC_API_KEY: '' };
});

// Approval routing: reverse a UserCreds per-member identity back to its agent group
// so credentialed-action approvals from a member's container reach the group's
// approvers.
registerApprovalAgentGroupFallback((externalId) => agentGroupForUserCredsAgent(externalId));

// Shared context: on a per-member wake, write the full room transcript into the
// member's session (current → trigger=1, rest → trigger=0).
registerPerMemberInboundWriter(writeMemberTranscript);

export {};
