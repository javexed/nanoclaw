// Module seams for inbound routing, plus the small helpers that keep the
// router's own insertion points to a line each.
import { recordDroppedMessage } from '../db/dropped-messages.js';
import { log } from '../log.js';
import { fanInboundMessage } from '../modules/cross-session-context/index.js';
import { resolveSession, writeSessionMessage } from '../session-manager.js';
import type { InboundEvent } from '../channels/adapter.js';
import type { MessagingGroup, Session } from '../types.js';
import { consultTurnGates, runSessionInboundWriter, type SessionKeyOverride } from './session-hooks.js';

/**
 * Inbound delivery-plan resolver: an installed module may decide, per event,
 * exactly which wired agents wake, which receive the message silently as
 * context, and which are skipped — replacing wiring-level engage evaluation
 * for that event. Powers multi-agent conversation surfaces (per-thread
 * participant sets; an agent's reply fanned to the other participants as
 * context so they stay in sync).
 *
 * Contract, applied by the router's fan-out loop when a plan is returned:
 *  - perAgent 'expected' → the agent wakes (trigger=1); access/scope gates
 *    still apply. 'defer' → delivered silently (trigger=0). Absent → skipped.
 *  - The hints (responseExpectation, participants, isPeerReply) are merged
 *    into the message content JSON — readers that don't know them ignore
 *    them.
 *  - A null plan (or no resolver) leaves routing exactly as today.
 */
export interface InboundDeliveryPlan {
  /** All participating agent_group_ids (forwarded to containers as a hint). */
  participants: string[];
  /** Per-agent delivery. Agents absent from the map are skipped entirely. */
  perAgent: Map<string, 'expected' | 'defer'>;
  /** True when this event is an agent's reply fanned to peers (context only). */
  isPeerReply?: boolean;
}
export type InboundDeliveryPlanResolver = (
  mg: MessagingGroup,
  threadId: string | null,
  messageText: string,
  /** The producing agent for agent-authored (looped-back) messages. */
  senderAgentGroupId: string | undefined,
) => InboundDeliveryPlan | null;
const deliveryPlanResolvers: InboundDeliveryPlanResolver[] = [];
export function registerInboundDeliveryPlanResolver(fn: InboundDeliveryPlanResolver): void {
  deliveryPlanResolvers.push(fn);
}
/**
 * Decision chain: resolvers are asked in registration order; the first
 * non-null plan wins. A registering module can never un-register another —
 * each surface's planner returns null for events it doesn't manage.
 */
export function resolveInboundDeliveryPlan(
  mg: MessagingGroup,
  threadId: string | null,
  messageText: string,
  senderAgentGroupId: string | undefined,
): InboundDeliveryPlan | null {
  for (const fn of deliveryPlanResolvers) {
    try {
      const plan = fn(mg, threadId, messageText, senderAgentGroupId);
      if (plan) return plan;
    } catch (err) {
      log.warn('Inbound delivery-plan resolver threw — skipping it', { err: String(err) });
    }
  }
  return null;
}

/**
 * What a plan says about one agent: `null` when the agent is not in the plan
 * (skip it entirely), else whether it wakes and the hints to ride in the
 * content JSON. The router still applies its own access/scope gates to a
 * waking agent.
 */
export function planForAgent(
  plan: InboundDeliveryPlan,
  agentGroupId: string,
): { wake: boolean; hints: Record<string, unknown> } | null {
  const expectation = plan.perAgent.get(agentGroupId);
  if (!expectation) return null;
  return {
    wake: expectation === 'expected',
    hints: {
      responseExpectation: expectation,
      participants: plan.participants,
      ...(plan.isPeerReply ? { isPeerReply: true } : {}),
    },
  };
}

/**
 * Consult the turn gates for one delivery. On veto, records the drop with the
 * module's reason and returns true; the router then returns before any
 * session exists. The user-facing notice is the vetoing module's own job.
 */
export async function vetoTurn(
  mg: MessagingGroup,
  agentGroupId: string,
  userId: string | null,
  event: InboundEvent,
): Promise<boolean> {
  const veto = await consultTurnGates(mg, agentGroupId, userId);
  if (!veto) return false;
  recordDroppedMessage({
    channel_type: event.channelType,
    platform_id: event.platformId,
    user_id: userId,
    sender_name: null,
    reason: veto.reason,
    messaging_group_id: mg.id,
    agent_group_id: agentGroupId,
  });
  log.info('Turn vetoed by module gate', { agentGroupId, userId, reason: veto.reason });
  return true;
}

export interface ReKeyedTurnCtx {
  /** The key override in effect for this turn, if a module re-keyed it. */
  keyOverride: SessionKeyOverride | null;
  wake: boolean;
  /** Routing hints from a delivery plan, merged into the content JSON. */
  hints?: Record<string, unknown>;
  roomId: string;
  currentMessageId: string;
}

/** The three upstream calls in deliverToAgent that a re-keyed turn changes. */
export interface DeliverToAgentCalls {
  resolveSession: typeof resolveSession;
  writeSessionMessage: typeof writeSessionMessage;
  fanInboundMessage: typeof fanInboundMessage;
}

/**
 * Wraps the three calls deliverToAgent makes that a module's session-key
 * override changes, so the router's own call lines stay upstream's byte for
 * byte — it rebinds the three names to these for the rest of the function.
 *
 *  - resolveSession substitutes the override's key and remembers the session.
 *  - writeSessionMessage lets the module's inbound writer own a re-keyed wake
 *    turn (e.g. a full room-transcript sync), and merges plan hints into the
 *    content JSON (best-effort — non-JSON content is delivered as-is).
 *  - fanInboundMessage is a no-op for a re-keyed session: the module that
 *    re-keyed it owns its cross-session visibility; fanning would copy one
 *    sibling's messages into another's queue — for member-keyed sessions a
 *    leak between users, not shared context.
 *
 * With no override and no hints every wrapper is a pass-through.
 */
export function reKeyedTurn(upstream: DeliverToAgentCalls, ctx: ReKeyedTurnCtx): DeliverToAgentCalls {
  const o = ctx.keyOverride;
  let resolved: Session | null = null;
  return {
    resolveSession: async (agentGroupId, messagingGroupId, threadId, sessionMode) => {
      const r = await upstream.resolveSession(
        agentGroupId,
        messagingGroupId,
        o ? o.threadId : threadId,
        o ? o.sessionMode : sessionMode,
      );
      resolved = r.session;
      return r;
    },
    writeSessionMessage: async (agentGroupId, sessionId, msg) => {
      if (o && ctx.wake && resolved) {
        const handled = await runSessionInboundWriter({
          agentGroupId,
          session: resolved,
          roomId: ctx.roomId,
          currentMessageId: ctx.currentMessageId,
          deliveryAddr: {
            platformId: msg.platformId ?? null,
            channelType: msg.channelType ?? null,
            threadId: msg.threadId ?? null,
          },
        });
        if (handled) return;
      }
      let content = msg.content;
      if (ctx.hints) {
        try {
          content = JSON.stringify({ ...JSON.parse(content), ...ctx.hints });
        } catch {
          /* non-JSON content — deliver without hints */
        }
      }
      await upstream.writeSessionMessage(agentGroupId, sessionId, { ...msg, content });
    },
    fanInboundMessage: o ? async () => 0 : upstream.fanInboundMessage,
  };
}
