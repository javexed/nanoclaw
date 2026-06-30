/**
 * UserCreds shared-context fan-out.
 *
 * On a per-member session's wake turn, write the full recent room transcript
 * into that member's session — the current message as the wake (trigger=1), the
 * rest as context (trigger=0) — so the responding agent always has the whole
 * conversation, even though each member runs in their own container. Idle
 * members catch up the same way when they next speak.
 *
 * Stable ids `user-creds-<session>-<roomMsgId>` make this idempotent: re-syncing each
 * turn only adds genuinely new messages. Content matches the webchat inbound
 * shape ({text, sender, senderName}) so the agent-runner formats it identically.
 *
 * BLAST RADIUS (by design): in a SHARED UserCreds room, every connected member's
 * own container receives the full room transcript — i.e. each member's container
 * is a read surface for all members' message *content* (never their
 * credentials — keys never cross containers). This is the price of giving each
 * per-member agent full conversational context in a shared room. It is NOT a
 * fit for rooms whose members shouldn't see each other's messages; for that,
 * use separate (non-shared) agent groups or per-member rooms. Credential
 * isolation is unaffected — only transcript content fans out.
 */
import { getWebchatMessages } from '../../channels/webchat/db.js';
import { syncSessionContext, type ContextMessage, type PerMemberInboundArgs } from '../../session-manager.js';

const TRANSCRIPT_LIMIT = 60;
// Side-channel rows (a2a copies, approval cards) are not conversation turns.
const SKIP_TYPES = new Set(['a2a', 'approval', 'approval_resolved']);

export function writeMemberTranscript(args: PerMemberInboundArgs): boolean {
  const transcript = getWebchatMessages(args.roomId, TRANSCRIPT_LIMIT);
  const msgs: ContextMessage[] = [];
  let sawCurrent = false;
  for (const m of transcript) {
    if (SKIP_TYPES.has((m as { message_type?: string }).message_type ?? '')) continue;
    const isCurrent = m.id === args.currentMessageId;
    if (isCurrent) sawCurrent = true;
    msgs.push({
      id: `user-creds-${args.session.id}-${m.id}`,
      kind: 'chat',
      timestamp: new Date(m.created_at).toISOString(),
      platformId: args.deliveryAddr.platformId,
      channelType: args.deliveryAddr.channelType,
      threadId: args.deliveryAddr.threadId,
      content: JSON.stringify({ text: m.content, sender: m.sender, senderName: m.sender, senderId: '' }),
      trigger: isCurrent ? 1 : 0,
    });
  }
  // If the current message isn't in the transcript yet (timing), let the router
  // do its normal single-message write so the turn still wakes correctly.
  if (!sawCurrent) return false;
  syncSessionContext(args.agentGroupId, args.session.id, msgs);
  return true;
}
