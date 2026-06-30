/**
 * Inbound message routing.
 *
 * Channel adapter event → resolve messaging group → sender resolver →
 * resolve/pick agent → access gate → resolve/create session → write
 * messages_in → wake container.
 *
 * Two module hooks (registered by the permissions module):
 *   - `setSenderResolver` runs BEFORE agent resolution so user rows get
 *     upserted even if the message ends up dropped by agent wiring.
 *     Without the module, userId is null and downstream code tolerates it.
 *   - `setAccessGate` runs AFTER agent resolution so policy decisions can
 *     branch on the target agent group. Without the module, access is
 *     allow-all.
 *
 * `dropped_messages` is core audit infra. Core writes rows for structural
 * drops (no agent wired, no trigger match); the access gate writes rows
 * for policy refusals.
 */
import { getChannelAdapter } from './channels/channel-registry.js';
import { gateCommand } from './command-gate.js';
import { getAgentGroup } from './db/agent-groups.js';
import { recordDroppedMessage } from './db/dropped-messages.js';
import {
  createMessagingGroup,
  getMessagingGroupAgents,
  getMessagingGroupWithAgentCount,
} from './db/messaging-groups.js';
import { findSessionForAgent } from './db/sessions.js';
import { startTypingRefresh, stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import {
  resolveSession,
  resolveSessionKeyOverride,
  writePerMemberInbound,
  writeSessionMessage,
  writeOutboundDirect,
} from './session-manager.js';
import { wakeContainer } from './container-runner.js';
import { getSession } from './db/sessions.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent } from './types.js';
import type { InboundEvent } from './channels/adapter.js';

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Sender-resolver hook. Runs before agent resolution.
 *
 * The permissions module registers this to extract the sender's namespaced
 * user id and upsert the users row. Returns null when the payload doesn't
 * carry enough info to identify a sender. Without the hook, every message
 * arrives at the gate with userId=null.
 */
export type SenderResolverFn = (event: InboundEvent) => string | null;

let senderResolver: SenderResolverFn | null = null;

export function setSenderResolver(fn: SenderResolverFn): void {
  if (senderResolver) {
    log.warn('Sender resolver overwritten');
  }
  senderResolver = fn;
}

/**
 * Access-gate hook. Runs after agent resolution.
 *
 * The permissions module registers this; without it, core defaults to
 * allow-all. The gate receives the raw event so it can extract the sender
 * name for audit-trail purposes, and it is responsible for recording its
 * own `dropped_messages` row on refusal (structural drops are already
 * recorded by core before the gate runs).
 */
export type AccessGateResult = { allowed: true } | { allowed: false; reason: string };

export type AccessGateFn = (
  event: InboundEvent,
  userId: string | null,
  mg: MessagingGroup,
  agentGroupId: string,
) => AccessGateResult;

let accessGate: AccessGateFn | null = null;

export function setAccessGate(fn: AccessGateFn): void {
  if (accessGate) {
    log.warn('Access gate overwritten');
  }
  accessGate = fn;
}

/**
 * Per-wiring sender-scope hook. Runs alongside the access gate for each
 * agent that would otherwise engage — lets the permissions module enforce
 * `sender_scope='known'` on wirings that are stricter than the messaging
 * group's `unknown_sender_policy`. When the hook isn't registered (module
 * not installed), sender_scope is a no-op.
 */
export type SenderScopeGateFn = (
  event: InboundEvent,
  userId: string | null,
  mg: MessagingGroup,
  agent: MessagingGroupAgent,
) => AccessGateResult;

let senderScopeGate: SenderScopeGateFn | null = null;

export function setSenderScopeGate(fn: SenderScopeGateFn): void {
  if (senderScopeGate) {
    log.warn('Sender-scope gate overwritten');
  }
  senderScopeGate = fn;
}

/**
 * Per-thread engaged-agents resolver (webchat). For an engaged thread it returns
 * which agents participate and whether each is addressed (`'expected'` → wakes and
 * replies) or just listening (`'defer'` → receives the message as context, no
 * wake). Side effect: auto-engages @mentioned agents. Returns `null` when
 * engagement doesn't apply (non-webchat, regular chat, agent-authored fan-out, or
 * nothing engaged) — the router then uses the normal engage_mode logic. When no
 * resolver is registered (module absent) it's always `null`. See
 * docs/design/thread-engaged-agents.md.
 */
export interface EngagedDecision {
  engaged: string[]; // engaged agent_group_ids — passed to each container as a hint
  perAgent: Map<string, 'expected' | 'defer'>; // agents absent are NOT engaged → silent
  isPeerReply?: boolean; // true when this is an agent's reply fanned out to peers (context only)
}
export type EngagedResolverFn = (
  mg: MessagingGroup,
  threadId: string | null,
  messageText: string,
  // The producing agent for agent-authored messages (webchat loop-back) — used to
  // fan a reply out to the OTHER engaged agents; undefined for human messages.
  senderAgentGroupId: string | undefined,
) => EngagedDecision | null;

let engagedResolver: EngagedResolverFn | null = null;

export function setEngagedResolver(fn: EngagedResolverFn): void {
  if (engagedResolver) {
    log.warn('Engaged resolver overwritten');
  }
  engagedResolver = fn;
}

/**
 * Message-interceptor hook. Runs at the very top of routeInbound, before
 * messaging-group resolution. When the interceptor returns true the message
 * is consumed and routing stops. Used by the permissions module to capture
 * free-text replies during multi-step approval flows (e.g. agent naming).
 */
export type MessageInterceptorFn = (event: InboundEvent) => Promise<boolean>;

let messageInterceptor: MessageInterceptorFn | null = null;

export function setMessageInterceptor(fn: MessageInterceptorFn): void {
  messageInterceptor = fn;
}

/**
 * Channel-registration hook. Runs when the router sees a mention/DM on a
 * messaging group that has no wirings AND hasn't been denied. The hook is
 * expected to escalate to an owner (card, etc.) and arrange for future
 * replay via routeInbound after approval. Fire-and-forget from the
 * router's perspective.
 *
 * Registered by the permissions module. Without the module the router
 * silently records the drop with reason='no_agent_wired' and moves on.
 */
export type ChannelRequestGateFn = (mg: MessagingGroup, event: InboundEvent) => Promise<void>;

let channelRequestGate: ChannelRequestGateFn | null = null;

export function setChannelRequestGate(fn: ChannelRequestGateFn): void {
  if (channelRequestGate) {
    log.warn('Channel-request gate overwritten');
  }
  channelRequestGate = fn;
}

function safeParseContent(raw: string): { text?: string; sender?: string; senderId?: string } {
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

/**
 * Route an inbound message from a channel adapter to the correct session.
 * Creates messaging group + session if they don't exist yet.
 */
export async function routeInbound(event: InboundEvent): Promise<void> {
  // Pre-route interceptor — lets modules consume messages before any routing
  // (e.g. free-text replies during multi-step approval flows).
  if (messageInterceptor && (await messageInterceptor(event))) return;

  // 0. Apply the adapter's thread policy. Non-threaded adapters (Telegram,
  //    WhatsApp, iMessage, email) collapse threads to the channel. Resolved
  //    by the RECEIVING instance — sibling instances of one platform can
  //    differ in thread support.
  const adapter = getChannelAdapter(event.instance ?? event.channelType);
  if (adapter && !adapter.supportsThreads) {
    event = { ...event, threadId: null };
  }

  const isMention = event.message.isMention === true;

  // 1. Combined lookup: messaging_group row + count of wired agents in a
  //    single query. Cheap short-circuit for the common "unwired channel"
  //    case — one DB read and we're out, no auto-create, no sender
  //    resolution, no log spam. Exact-on-instance: an unknown named
  //    instance falls through to auto-create rather than hijacking a
  //    sibling instance's row.
  const found = getMessagingGroupWithAgentCount(
    event.channelType,
    event.platformId,
    event.instance ?? event.channelType,
  );

  let mg: MessagingGroup;
  let agentCount: number;
  if (!found) {
    // No messaging_groups row. Auto-create only when the message warrants
    // attention (the bot was addressed — @mention or DM). Plain chatter in
    // channels we merely sit in stays silent — no row, no DB writes.
    if (!isMention) return;
    const mgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mg = {
      id: mgId,
      channel_type: event.channelType,
      platform_id: event.platformId,
      // Persist the receiving instance — without this, the first bot's row
      // would absorb every sibling instance's traffic.
      instance: event.instance ?? event.channelType,
      name: null,
      is_group: event.message.isGroup ? 1 : 0,
      unknown_sender_policy: 'request_approval',
      denied_at: null,
      created_at: new Date().toISOString(),
    };
    createMessagingGroup(mg);
    log.info('Auto-created messaging group', {
      id: mgId,
      channelType: event.channelType,
      platformId: event.platformId,
    });
    agentCount = 0;
  } else {
    mg = found.mg;
    agentCount = found.agentCount;
  }

  // 1b. No wirings — either silent drop (plain chatter / denied channel) or
  //     escalate to owner for channel-registration approval.
  if (agentCount === 0) {
    if (!isMention) return;
    if (mg.denied_at) {
      log.debug('Message dropped — channel was denied by owner', {
        messagingGroupId: mg.id,
        deniedAt: mg.denied_at,
      });
      return;
    }

    const parsed = safeParseContent(event.message.content);
    recordDroppedMessage({
      channel_type: event.channelType,
      platform_id: event.platformId,
      user_id: null,
      sender_name: parsed.sender ?? null,
      reason: 'no_agent_wired',
      messaging_group_id: mg.id,
      agent_group_id: null,
    });

    if (channelRequestGate) {
      // Fire-and-forget escalation. The gate is expected to build a card,
      // persist pending_channel_approvals, and replay the event via
      // routeInbound after approval. Errors are logged internally — the
      // user's message still stays dropped here either way.
      void channelRequestGate(mg, event).catch((err) =>
        log.error('Channel-request gate threw', { messagingGroupId: mg.id, err }),
      );
    } else {
      log.warn('MESSAGE DROPPED — no agent groups wired and no channel-request gate registered', {
        messagingGroupId: mg.id,
        channelType: event.channelType,
        platformId: event.platformId,
      });
    }
    return;
  }

  // 2. Sender resolution (permissions module upserts the users row as a
  //    side effect so later role/access lookups find a real record).
  //    Without the module, userId is null — downstream tolerates it.
  const userId: string | null = senderResolver ? senderResolver(event) : null;

  // 3. Fetch wired agents in full (we already know the count is > 0; now
  //    we need their actual rows for fan-out).
  const agents = getMessagingGroupAgents(mg.id);

  // 4. Fan-out: evaluate each wired agent independently against engage_mode,
  //    sender_scope, and access gate. An agent that engages gets its own
  //    session and container wake. An agent that declines but has
  //    ignored_message_policy='accumulate' still gets the message stored in
  //    its session (trigger=0) so the context is available when it does
  //    engage later. Drop policy = skip silently.
  //
  //    Subscribe (for mention-sticky wirings on threaded platforms) fires
  //    once per message from this loop — the first engaging mention-sticky
  //    wiring triggers adapter.subscribe(...); subsequent wirings don't
  //    re-subscribe (chat.subscribe is idempotent anyway, but the flag
  //    avoids the extra await).
  const parsed = safeParseContent(event.message.content);
  const messageText = parsed.text ?? '';
  // Agent-authored fan-out (e.g. webchat loop-back). Tightens engagement:
  // (1) the producing agent never re-engages on its own post (self-exclusion),
  // (2) prime-style negative-lookahead wirings — patterns like `^(?!...)` that
  //     model "catch any unaddressed human message" — are skipped, since their
  //     intent is to greet humans, not to chain off other agents' chatter.
  const senderAgentGroupId = event.message.senderAgentGroupId;

  // Engaged-agents overlay (webchat threads): resolve once. Non-null means this
  // thread routes by its engaged set (auto-engaging @mentioned agents) instead of
  // the per-wiring engage_mode. Null → normal routing (regular chat, non-webchat,
  // agent fan-out, or nothing engaged). See docs/design/thread-engaged-agents.md.
  const engagedDecision = engagedResolver ? engagedResolver(mg, event.threadId, messageText, senderAgentGroupId) : null;

  let engagedCount = 0;
  let accumulatedCount = 0;
  let subscribed = false;

  for (const agent of agents) {
    const agentGroup = getAgentGroup(agent.agent_group_id);
    if (!agentGroup) continue;

    // Lifecycle gate: only `active` agents respond. `paused` (benched) and
    // `archived` (retired) keep their wiring but never engage or wake — so a
    // message addressed to them is silently not delivered to a container.
    if (agentGroup.status && agentGroup.status !== 'active') continue;

    if (senderAgentGroupId && agent.agent_group_id === senderAgentGroupId) {
      // Self-exclusion: agent's own loop-back never re-engages itself.
      continue;
    }
    // Engaged-thread routing (runs BEFORE the prime-skip so an engaged prime
    // agent still receives peer context): bypass engage_mode entirely. Addressed
    // agents wake and reply; other engaged agents receive the message as silent
    // context (trigger=0) so they stay in sync and answer when next addressed; a
    // peer reply is fanned to the other engaged agents as context only. Agents not
    // in the engaged set are skipped. The responseExpectation / engagedAgents /
    // isPeerReply hint rides in the content JSON (no schema change).
    if (engagedDecision) {
      const expectation = engagedDecision.perAgent.get(agent.agent_group_id);
      if (!expectation) continue; // not engaged in this thread → silent
      const engagedWake = expectation === 'expected';
      if (engagedWake) {
        const eAccessOk = !accessGate || accessGate(event, userId, mg, agent.agent_group_id).allowed;
        const eScopeOk = !senderScopeGate || senderScopeGate(event, userId, mg, agent).allowed;
        if (!eAccessOk || !eScopeOk) continue;
      }
      await deliverToAgent(agent, agentGroup, mg, event, userId, adapter?.supportsThreads === true, engagedWake, {
        responseExpectation: expectation,
        engagedAgents: engagedDecision.engaged,
        ...(engagedDecision.isPeerReply ? { isPeerReply: true } : {}),
      });
      if (engagedWake) engagedCount++;
      else accumulatedCount++;
      continue;
    }

    if (senderAgentGroupId && agent.engage_pattern?.startsWith('^(?!')) {
      // Prime negative-lookahead: catch-all for unaddressed *human* messages.
      // Skipping on agent fan-out prevents the prime from sweeping in on every
      // unaddressed agent reply (which would chain forever).
      continue;
    }

    const engages = evaluateEngage(agent, messageText, isMention, mg, event.threadId);

    const accessOk = engages && (!accessGate || accessGate(event, userId, mg, agent.agent_group_id).allowed);
    const scopeOk = engages && (!senderScopeGate || senderScopeGate(event, userId, mg, agent).allowed);

    if (engages && accessOk && scopeOk) {
      await deliverToAgent(agent, agentGroup, mg, event, userId, adapter?.supportsThreads === true, true);
      engagedCount++;

      // Mention-sticky: ask the adapter to subscribe the thread so the
      // platform's subscribed-message path carries follow-ups without
      // requiring another @mention. Threaded-adapter only; DMs and
      // non-threaded platforms skip.
      if (
        !subscribed &&
        agent.engage_mode === 'mention-sticky' &&
        adapter?.supportsThreads &&
        adapter.subscribe &&
        event.threadId !== null &&
        mg.is_group !== 0
      ) {
        subscribed = true;
        // Fire-and-forget — subscribe is platform-side bookkeeping and
        // shouldn't block message routing. Errors are logged inside the
        // adapter (or by the promise rejection handler below).
        void adapter.subscribe(event.platformId, event.threadId).catch((err) => {
          log.warn('adapter.subscribe failed', { channelType: event.channelType, threadId: event.threadId, err });
        });
      }
    } else if (agent.ignored_message_policy === 'accumulate' && !(engages && (!accessOk || !scopeOk))) {
      // Accumulate stores the message as silent context. We allow it when
      // engagement simply didn't fire, but NOT when engagement fired and
      // the access/scope gate refused — those refusals are security
      // decisions about an untrusted sender, and silently storing their
      // message (which also stages their attachments to disk via
      // writeSessionMessage → extractAttachmentFiles) is exactly what the
      // gate is meant to prevent.
      await deliverToAgent(agent, agentGroup, mg, event, userId, adapter?.supportsThreads === true, false);
      accumulatedCount++;
    } else {
      log.debug('Message not engaged for agent (drop policy)', {
        agentGroupId: agent.agent_group_id,
        engage_mode: agent.engage_mode,
        engages,
        accessOk,
        scopeOk,
      });
    }
  }

  if (engagedCount + accumulatedCount === 0) {
    recordDroppedMessage({
      channel_type: event.channelType,
      platform_id: event.platformId,
      user_id: userId,
      sender_name: parsed.sender ?? null,
      reason: 'no_agent_engaged',
      messaging_group_id: mg.id,
      agent_group_id: null,
    });
  }
}

/**
 * Decide whether a given wired agent should engage on this message.
 *
 *   'pattern'        — regex test on text; '.' = always
 *   'mention'        — bot must be mentioned on the platform. Resolved by
 *                      the adapter (SDK-level) and forwarded as
 *                      `event.message.isMention`. Agent display name
 *                      (`agent_group.name`) is irrelevant — users address
 *                      the bot via its platform username (@botname on
 *                      Telegram, user-id mention on Slack/Discord), not
 *                      via the agent's NanoClaw-side display name. If a
 *                      user wants to disambiguate between multiple agents
 *                      wired to one chat, use engage_mode='pattern' with
 *                      the disambiguator as the regex.
 *   'mention-sticky' — platform mention OR an active per-thread session
 *                      already exists for this (agent, mg, thread). The
 *                      session existence IS our subscription state; once
 *                      a thread has engaged us once, follow-ups arrive
 *                      with no mention and should still fire.
 */
/**
 * Strip markdown code regions (triple-backtick fences + single-backtick inline)
 * so engage-pattern regex doesn't treat `@handle` inside a code span as a live
 * mention. Replacing matches with empty strings is safe — pattern matching is
 * boolean (presence/absence), so the resulting text just lacks the masked
 * region. Order matters: fences first (greedy across newlines) so triple
 * backticks don't get eaten one at a time by the inline pass.
 *
 * Edge cases:
 *   - Unbalanced backticks fall through unstripped (e.g. a single ` with no
 *     closer leaves the rest of the line addressable — wrong markdown but the
 *     safer router default is "engage on apparent mentions").
 *   - The regex is non-greedy so multiple code spans on one line work.
 */
export function stripCodeRegions(text: string): string {
  let t = text.replace(/```[\s\S]*?```/g, '');
  t = t.replace(/`[^`\n]*`/g, '');
  return t;
}

function evaluateEngage(
  agent: MessagingGroupAgent,
  text: string,
  isMention: boolean,
  mg: MessagingGroup,
  threadId: string | null,
): boolean {
  switch (agent.engage_mode) {
    case 'pattern': {
      const pat = agent.engage_pattern ?? '.';
      if (pat === '.') return true;
      try {
        // Strip markdown code regions before pattern matching so handles inside
        // backticks are treated as literal text, not live mentions. Triple-
        // backtick fences (```@advisor```) and single-backtick inline code
        // (`@advisor`) both protect. Unbalanced backticks pass through so a
        // stray ` doesn't accidentally mask the rest of the message.
        return new RegExp(pat).test(stripCodeRegions(text));
      } catch {
        // Bad regex: fail open so admin sees the agent responding + can fix.
        return true;
      }
    }
    case 'mention':
      return isMention;
    case 'mention-sticky': {
      if (isMention) return true;
      // Sticky follow-up: session already exists for this (agent, mg, thread)
      // — the thread was activated before, keep firing.
      if (mg.is_group === 0) return false; // DMs never use mention-sticky sensibly
      const existing = findSessionForAgent(agent.agent_group_id, mg.id, threadId);
      return existing !== undefined;
    }
    default:
      return false;
  }
}

async function deliverToAgent(
  agent: MessagingGroupAgent,
  agentGroup: AgentGroup,
  mg: MessagingGroup,
  event: InboundEvent,
  userId: string | null,
  adapterSupportsThreads: boolean,
  wake: boolean,
  // Optional routing hints merged into the message content JSON (engaged-agents:
  // responseExpectation / engagedAgents / isPeerReply). Ignored by readers that
  // don't look for them. See docs/design/thread-engaged-agents.md.
  hints?: Record<string, unknown>,
): Promise<void> {
  // Apply the adapter thread policy: threaded adapter in a group chat →
  // per-thread session regardless of wiring. agent-shared preserved (it's
  // a cross-channel directive the adapter doesn't know about). DMs collapse
  // sub-threads to one session (is_group=0 short-circuit).
  let effectiveSessionMode = agent.session_mode;
  if (adapterSupportsThreads && effectiveSessionMode !== 'agent-shared' && mg.is_group !== 0) {
    effectiveSessionMode = 'per-thread';
  }

  // An installed module (UserCreds) may redirect this turn to a per-member session
  // keyed by the sender — so each person's turn runs in a container bearing
  // their own credential identity. Default (no resolver) leaves keying as-is.
  let sessionThreadId = event.threadId;
  const keyOverride = resolveSessionKeyOverride(mg, agent.agent_group_id, userId);
  if (keyOverride && 'block' in keyOverride) {
    // e.g. a 'required' UserCreds room where this member hasn't connected a key —
    // decline the turn and tell them how to fix it (never bill the shared key).
    if (wake) {
      writeOutboundDirect(agent.agent_group_id, agent.agent_group_id, {
        id: `user-creds-block-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        platformId: event.replyTo?.platformId ?? event.platformId,
        channelType: event.replyTo?.channelType ?? event.channelType,
        threadId: event.replyTo?.threadId ?? event.threadId,
        content: JSON.stringify({ text: keyOverride.block }),
      });
    }
    recordDroppedMessage({
      channel_type: event.channelType,
      platform_id: event.platformId,
      user_id: userId,
      sender_name: null,
      reason: 'user-creds-required-no-key',
      messaging_group_id: mg.id,
      agent_group_id: agent.agent_group_id,
    });
    return;
  }
  const perMember = keyOverride !== null;
  if (keyOverride) {
    effectiveSessionMode = keyOverride.sessionMode;
    sessionThreadId = keyOverride.threadId;
  }
  const { session, created } = resolveSession(agent.agent_group_id, mg.id, sessionThreadId, effectiveSessionMode);

  // The inbound row's (channel_type, platform_id, thread_id) is the address
  // the agent's reply will be delivered to. Normally it mirrors the source
  // (stamped from the event). When the caller supplied `replyTo` (CLI admin
  // transport acting on operator intent), the reply is redirected there.
  const deliveryAddr = event.replyTo ?? {
    channelType: event.channelType,
    platformId: event.platformId,
    threadId: event.threadId,
  };

  // Command gate: classify slash commands before they reach the container.
  // Filtered commands are dropped silently. Denied admin commands get a
  // permission-denied response written directly to messages_out.
  if (event.message.kind === 'chat' || event.message.kind === 'chat-sdk') {
    const gate = gateCommand(event.message.content, userId, agent.agent_group_id);
    if (gate.action === 'filter') {
      log.debug('Filtered command dropped by gate', { agentGroupId: agent.agent_group_id });
      return;
    }
    if (gate.action === 'deny') {
      writeOutboundDirect(session.agent_group_id, session.id, {
        id: `deny-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        platformId: deliveryAddr.platformId,
        channelType: deliveryAddr.channelType,
        threadId: deliveryAddr.threadId,
        content: JSON.stringify({ text: `Permission denied: ${gate.command} requires admin access.` }),
      });
      log.info('Admin command denied by gate', { command: gate.command, userId, agentGroupId: agent.agent_group_id });
      return;
    }
  }

  // UserCreds per-member shared-context: on a wake turn, let the module write the
  // full room transcript into this member's session (current → trigger=1, the
  // rest → trigger=0). If it handles the write, skip the normal single-message
  // write below.
  const handledByMember =
    perMember && wake
      ? writePerMemberInbound({
          agentGroupId: agent.agent_group_id,
          session,
          roomId: mg.platform_id,
          currentMessageId: event.message.id,
          deliveryAddr,
        })
      : false;

  if (!handledByMember) {
    // Merge any routing hints into the content JSON (best-effort — leave as-is if
    // content isn't parseable JSON).
    let content = event.message.content;
    if (hints) {
      try {
        content = JSON.stringify({ ...JSON.parse(content), ...hints });
      } catch {
        /* non-JSON content — deliver without hints */
      }
    }
    writeSessionMessage(session.agent_group_id, session.id, {
      id: messageIdForAgent(event.message.id, agent.agent_group_id),
      kind: event.message.kind,
      timestamp: event.message.timestamp,
      platformId: deliveryAddr.platformId,
      channelType: deliveryAddr.channelType,
      threadId: deliveryAddr.threadId,
      content,
      trigger: wake ? 1 : 0,
    });
  }

  log.info('Message routed', {
    sessionId: session.id,
    agentGroup: agent.agent_group_id,
    engage_mode: agent.engage_mode,
    kind: event.message.kind,
    userId,
    wake,
    created,
    agentGroupName: agentGroup.name,
  });

  if (wake) {
    // Typing indicator + wake are only for the engaged branch; accumulated
    // messages sit silently until a real trigger fires.
    // Typing fires via the adapter instance that owns this chat's row.
    startTypingRefresh(
      session.id,
      session.agent_group_id,
      agentGroup.name,
      event.channelType,
      event.platformId,
      event.threadId,
      mg.instance,
    );
    const freshSession = getSession(session.id);
    if (freshSession) {
      const woke = await wakeContainer(freshSession);
      // wakeContainer never throws — it returns false on transient spawn
      // failure (host-sweep retries). Stop the typing indicator we just
      // started so it doesn't leak; the inbound row stays pending.
      if (!woke) stopTypingRefresh(freshSession.id);
    }
  }
}

/**
 * When fanning out, the same inbound message lands in multiple per-agent
 * session DBs. messages_in.id is PRIMARY KEY, so reuse of the raw id would
 * collide across sessions (or, more subtly, within one session if re-routed
 * after a retry). Namespace by agent_group_id to keep ids unique per session.
 */
function messageIdForAgent(baseId: string | undefined, agentGroupId: string): string {
  const id = baseId && baseId.length > 0 ? baseId : generateId();
  return `${id}:${agentGroupId}`;
}
