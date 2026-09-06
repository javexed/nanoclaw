// Module seams on the delivery side: per-session observers run by both
// delivery polls, the agent-activity status type rich clients render, and
// the fields an adapter needs to attribute or loop back agent-authored
// messages. The fields are declared as augmentations of upstream's adapter
// interfaces so the upstream file itself stays untouched.
import { log } from '../log.js';
import type { Session } from '../types.js';
import type { OutboundFile } from '../channels/adapter.js';

declare module '../delivery.js' {
  interface ChannelDeliveryAdapter {
    /**
     * Same as upstream's deliver, plus the producing session/agent — adapters
     * that attribute or loop back agent posts read it (see
     * OutboundMessage.senderSessionId). Optional and last, so every existing
     * implementation and caller still type-checks.
     */
    deliver(
      channelType: string,
      platformId: string,
      threadId: string | null,
      kind: string,
      content: string,
      files?: OutboundFile[],
      instance?: string,
      source?: { sessionId: string; agentGroupId: string },
    ): Promise<string | undefined>;
    /**
     * Same as upstream's setTyping, plus which agent is typing (display name)
     * so multi-agent surfaces can render one indicator per agent.
     */
    setTyping?(
      channelType: string,
      platformId: string,
      threadId: string | null,
      instance?: string,
      status?: string,
      statusKind?: 'auto' | 'agent',
      agentName?: string,
    ): Promise<void>;
    /**
     * Optional, like setTyping: forward live agent-activity status to a channel
     * that can render it. Channels with no status surface simply omit it.
     */
    sendStatus?(
      channelType: string,
      platformId: string,
      threadId: string | null,
      status: AgentActivityStatus,
      instance?: string,
    ): Promise<void>;
  }
}

declare module '../channels/adapter.js' {
  interface InboundMessage {
    /**
     * When set, this inbound was authored by an agent (loop-back fan-out from
     * an adapter that re-routes agent posts through onInbound). The value is
     * the producing agent's `agent_group_id`. The router uses it for
     * self-exclusion and passes it to the inbound delivery-plan resolver.
     * Adapters that don't loop back leave it undefined.
     */
    senderAgentGroupId?: string;
  }
  interface OutboundMessage {
    /**
     * Producing session's id. Threaded through delivery so adapters that need
     * to know exactly who emitted the message (e.g. for sender attribution or
     * loop-back fan-out) don't have to fall back to most-recently-active
     * heuristics that race under concurrent containers.
     */
    senderSessionId?: string;
    /** Producing session's agent_group_id (correlates with `senderSessionId`). */
    senderAgentGroupId?: string;
  }
}

/**
 * Fine-grained agent activity status for the current turn, surfaced to rich
 * clients for a live "thinking"/activity display. Cosmetic; carries no routing
 * data.
 *   - start:     a turn began; show the bubble and keep it until done/stalled
 *   - tool:      `text` = tool name, `detail` = target (file/command/query)
 *   - progress:  `text` = milestone message
 *   - reasoning: `text` = a reasoning summary line
 *   - done:      the turn finished cleanly; clear the activity display
 *   - stalled:   the turn ended abnormally (container died/killed mid-turn);
 *                `text` = a short human notice. Host-generated, not from the
 *                container's status feed.
 */
export interface AgentActivityStatus {
  kind: 'start' | 'tool' | 'progress' | 'reasoning' | 'done' | 'stalled';
  text: string | null;
  detail: string | null;
  /**
   * Which agent this activity is from — its display name (the agent group's
   * name). Lets a multi-agent room render one thinking bubble per agent instead
   * of interleaving everyone's activity into one. Null on the rare frame where
   * the agent group can't be resolved (renders under a generic label).
   */
  agentName?: string | null;
}

/**
 * Per-session observers run by both delivery polls after a session's messages
 * are delivered. An installed module reads its own per-session side-state
 * here (e.g. forwarding activity status to rich clients). Inert when nothing
 * registers; a throwing observer is isolated so it can never disrupt message
 * delivery. The sweep poll runs them too: the active poll only covers RUNNING
 * sessions, so a module reconciling state for a session whose container
 * already exited needs the sweep's all-active pass.
 */
type SessionDeliveryObserver = (session: Session) => Promise<void>;
const sessionDeliveryObservers: SessionDeliveryObserver[] = [];
export function registerSessionDeliveryObserver(fn: SessionDeliveryObserver): void {
  sessionDeliveryObservers.push(fn);
}
export async function runSessionDeliveryObservers(session: Session): Promise<void> {
  for (const fn of sessionDeliveryObservers) {
    try {
      await fn(session);
    } catch (err) {
      log.warn('Session delivery observer failed', { sessionId: session.id, err: String(err) });
    }
  }
}
