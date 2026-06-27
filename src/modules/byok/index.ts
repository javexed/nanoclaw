/**
 * BYOK module — secure shared-room bring-your-own-key.
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
import { registerAgentIdentityResolver, registerContainerEnvResolver } from '../../container-runtime.js';
import { writeMemberTranscript } from './fanout.js';
import { getDb, hasTable } from '../../db/connection.js';
import { registerApprovalAgentGroupFallback } from '../approvals/onecli-approvals.js';
import { getEffectiveRoomMode, getCredentialsConfig } from '../../channels/webchat/db.js';
import { userHasActiveKey, userHasActiveOauth, agentGroupForByokAgent } from './db.js';
import { byokAgentIdentifier } from './identity.js';

// Sentinel bearer for a per-member OAuth container. Its value is irrelevant
// beyond being non-empty: it flips Claude Code into OAuth mode (so it sends
// `Authorization: Bearer <sentinel>` + the oauth beta header), and OneCLI
// overwrites it on the wire with the member's real vault token. Mirrors the
// host-side drafter (src/channels/webchat/drafter.ts).
const OAUTH_SENTINEL = 'placeholder';

registerSessionKeyResolver((mg, agentGroupId, userId) => {
  // BYOK is webchat-only and opt-in per room. Fail safe to no override.
  if (mg.channel_type !== 'webchat' || !userId) return null;
  if (!hasTable(getDb(), 'webchat_room_settings')) return null;
  // Effective mode = the room's override, else the global default. OAuth/key
  // allowances are workspace-wide (set on the Credentials admin page).
  const mode = getEffectiveRoomMode(mg.platform_id);
  const oauthAllowed = getCredentialsConfig().allowClaudeOauth;
  // BYOK entirely off for this room (no API-key mode AND no OAuth) → no override.
  if (mode === 'disabled' && !oauthAllowed) return null;
  // A member with their own credential — API key OR OAuth subscription — gets
  // their own per-member session keyed by userId. (An OAuth-only room has
  // mode='disabled' but oauthAllowed=true, so this must not gate on mode.)
  if (userHasActiveKey(userId, agentGroupId)) {
    return { sessionMode: 'per-thread', threadId: userId };
  }
  // No key: API-key 'required' rooms decline with guidance; otherwise (optional,
  // or OAuth-only) fall back to the shared session (no override).
  if (mode === 'required') {
    return { block: 'This room requires your own Anthropic key — connect it in the banner above the chat.' };
  }
  return null;
});

// A per-member session (thread_id = userId) whose member has an active key
// spawns under the member's own OneCLI identity → gateway injects THEIR key.
registerAgentIdentityResolver((agentGroupId, threadId) => {
  if (threadId && userHasActiveKey(threadId, agentGroupId)) {
    return byokAgentIdentifier(agentGroupId, threadId);
  }
  return null;
});

// OAuth members: put their per-member container in subscription/OAuth mode with
// a SENTINEL token and route Anthropic THROUGH OneCLI (no NO_PROXY) — OneCLI
// swaps the sentinel for the member's real token, stored in their vault. The
// real token never enters the container. API-key members get {} here (their key
// is injected as x-api-key by OneCLI, no OAuth mode needed).
registerContainerEnvResolver((agentGroupId, threadId): Record<string, string> => {
  if (!threadId || !userHasActiveOauth(threadId, agentGroupId)) return {};
  return { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_SENTINEL };
});

// Approval routing: reverse a BYOK per-member identity back to its agent group
// so credentialed-action approvals from a member's container reach the group's
// approvers.
registerApprovalAgentGroupFallback((externalId) => agentGroupForByokAgent(externalId));

// Shared context: on a per-member wake, write the full room transcript into the
// member's session (current → trigger=1, rest → trigger=0).
registerPerMemberInboundWriter(writeMemberTranscript);

export {};
