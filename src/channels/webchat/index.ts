/**
 * Webchat channel — embedded HTTP + WebSocket chat server with PWA frontend.
 *
 * Disabled by default. Enable with `WEBCHAT_ENABLED=true` in .env. The server
 * binds to `WEBCHAT_HOST` (default 127.0.0.1) on `WEBCHAT_PORT` (default 3100).
 *
 * Auth modes (selected via `WEBCHAT_AUTH_MODE`):
 *   - localhost      single-machine, no auth (default when host is loopback)
 *   - bearer         shared token in `WEBCHAT_TOKEN`
 *   - tailscale      tailnet whois → email becomes the user identity
 *   - proxy-header   trust X-Forwarded-User from a fronting reverse proxy
 *
 * Identity → user_id mapping (used by permissions module if installed):
 *   - localhost      → "webchat:local-owner"
 *   - bearer         → "webchat:owner"  (one shared identity per token)
 *   - tailscale      → "webchat:tailscale:<email>"
 *   - proxy-header   → "webchat:<x-forwarded-user>"
 *
 * Privilege model:
 *   - First identity to log in is auto-granted role='owner' (when permissions
 *     module is installed). Subsequent identities have no role until granted.
 *   - Admin operations (create/delete/wire agents) gated on hasAdminPrivilege().
 *   - Without the permissions module, the gate degrades to "single trusted
 *     operator" — anyone with bearer/proxy access has full control.
 *
 * Schema lives in central DB (see migration.ts):
 *   - webchat_rooms        room metadata (id, name, created_at)
 *   - webchat_messages     full message log for PWA history view
 *   - webchat_push_subscriptions  Web Push endpoints
 *
 * The adapter mirrors agent traffic into webchat_messages so the PWA has a
 * unified history view; routing/delivery still flows through v2's session
 * DBs (inbound.db / outbound.db) like every other channel.
 */
// Side-effect import — must run before any transitive webchat import that
// reads `process.env.WEBCHAT_*` at module load (auth.ts, server.ts, push.ts,
// drafter.ts). See env-load.ts for the rationale.
import './env-load.js';

import { randomUUID } from 'crypto';

import { log } from '../../log.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup, getMessagingGroup, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { registerChannelAdapter } from '../channel-registry.js';
import type { AgentActivityStatus, ChannelAdapter, ChannelSetup, OutboundMessage } from '../adapter.js';
import { redactSensitiveData } from './redact.js';
import { startWebchatServer, stopWebchatServer, type WebchatServer } from './server.js';
import {
  APPROVAL_INBOX_PREFIX,
  deleteWebchatApprovalIndex,
  findActiveAgentForWebchatRoom,
  getWebchatApprovalInboxes,
  getWebchatRoom,
  isApprovalInbox,
  markRoomApprovalResolved,
  recordWebchatApproval,
  storeWebchatApprovalCard,
  storeWebchatMessage,
  storeWebchatFileMessage,
  userForApprovalInbox,
  type FileMeta,
  type WebchatRoomAgent,
} from './db.js';
import { broadcast, pushApprovalResolvedToUser, pushApprovalToUser } from './state.js';
import {
  registerApprovalRequestedListener,
  registerApprovalResolvedHandler,
} from '../../modules/approvals/primitive.js';
import { startReconcileLoop, stopReconcileLoop } from './reconcile.js';

export const CHANNEL_TYPE = 'webchat';

function isEnabled(): boolean {
  return process.env.WEBCHAT_ENABLED === 'true';
}

function createAdapter(): ChannelAdapter {
  let server: WebchatServer | null = null;
  // Captured at setup() time so deliver()'s loop-back fan-out can re-enter
  // the router. Null before setup, immutable after.
  let adapterConfig: ChannelSetup | null = null;

  const adapter: ChannelAdapter = {
    name: 'webchat',
    channelType: CHANNEL_TYPE,
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      adapterConfig = config;
      server = await startWebchatServer({
        onInbound: (roomId, message) => {
          // Surface the room's display name to the router so messaging_groups
          // gets a friendly label on first sight (mirrors discord/slack).
          const room = getWebchatRoom(roomId);
          if (room) {
            config.onMetadata(roomId, room.name, true);
          }
          // Standard inbound — userId resolution + access gating happens in
          // the router/permissions module via the `senderId` field that the
          // server attaches to message.content.
          void config.onInbound(roomId, null, message);
        },
        onAction: (questionId, selectedOption, userId) => {
          config.onAction(questionId, selectedOption, userId);
        },
      });
      log.info('Webchat channel listening', { host: server.host, port: server.port, tls: server.tls });
      // Reconcile loop — recovers messages lost to a known race where
      // trunk's deliveryAdapter wrapper can transiently log "No adapter
      // for channel type webchat" and mark a message delivered without
      // actually delivering. See reconcile.ts for details.
      startReconcileLoop(server);
      // Agents spawned outside the PWA (e.g. via a2a's `create_agent` MCP
      // tool) intentionally have no webchat wiring. The operator wires
      // them into rooms on demand — agents are entities, rooms are
      // conversation spaces, and we don't conflate the two.
    },

    async teardown(): Promise<void> {
      stopReconcileLoop();
      if (server) {
        await stopWebchatServer(server);
        server = null;
      }
    },

    isConnected(): boolean {
      return server !== null;
    },

    async openDM(handle: string): Promise<string> {
      // Per-user approval inbox: synthetic messaging_groups row keyed on the
      // handle, hidden from the room list. requestApproval() ultimately calls
      // adapter.deliver(channel_type='webchat', platform_id=this) which we
      // route to a per-user WS push instead of storing as a chat message.
      const platformId = `${APPROVAL_INBOX_PREFIX}${handle}`;
      if (!getMessagingGroupByPlatform('webchat', platformId)) {
        createMessagingGroup({
          id: randomUUID(),
          channel_type: 'webchat',
          platform_id: platformId,
          name: `Approvals (${handle})`,
          is_group: 0,
          unknown_sender_policy: 'public',
          created_at: new Date().toISOString(),
        });
      }
      return platformId;
    },

    async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
      if (!server) return undefined;

      // Approval inbox path: ask_question payloads (and only those) to a
      // synthetic approvals: platform_id push to the connected approver's
      // clients via WS. They never become chat messages.
      if (isApprovalInbox(platformId)) {
        const handle = platformId.slice(APPROVAL_INBOX_PREFIX.length);
        const approverUserId = `webchat:${handle}`;
        const content = message.content as Record<string, unknown> | string | undefined;
        if (content && typeof content === 'object' && content.type === 'ask_question') {
          // Stamp the approval into the webchat-side index so the PWA's
          // /api/approvals/pending query can find it later. We do this in
          // the deliver() path rather than relying on trunk's
          // requestApproval to populate pending_approvals.platform_id.
          // (The questionId field on the ask_question card IS the
          // pending_approvals.approval_id.)
          const approvalId = (content as { questionId?: unknown }).questionId;
          if (typeof approvalId === 'string' && approvalId.length > 0) {
            recordWebchatApproval(approvalId, platformId);
          } else {
            log.warn('Webchat: ask_question card missing questionId — approval not indexed', {
              platformId,
            });
          }
          pushApprovalToUser(approverUserId, content);
        } else {
          log.warn('Webchat: non-ask_question delivery to approval inbox dropped', {
            platformId,
            kind: typeof content === 'object' ? (content as { type?: string }).type : typeof content,
          });
        }
        return undefined;
      }

      const roomId = platformId;
      const room = getWebchatRoom(roomId);
      if (!room) {
        log.warn('Webchat deliver: unknown room', { roomId });
        return undefined;
      }
      // Resolve the producing agent. Prefer the agent_group_id threaded
      // through `message.senderAgentGroupId` from delivery.ts — that's the
      // ground truth (we know exactly which session emitted the message
      // because we polled its outbound.db). Fall back to the heuristic only
      // for legacy paths that don't set the field (defensive — should be
      // populated for all real deliveries after the threading change).
      let producer = message.senderAgentGroupId ? lookupAgentForMessage(message.senderAgentGroupId) : null;
      if (!producer) producer = findActiveAgentForWebchatRoom(roomId);
      const senderName = producer?.name ?? agentDisplayName();
      const text = extractText(message);
      let storedMessageId: string | null = null;
      if (text !== null && text.length > 0) {
        const stored = storeWebchatMessage(roomId, senderName, 'agent', text);
        server.broadcast(roomId, { type: 'message', ...stored });
        storedMessageId = stored.id;
      }
      // File attachments: stored as separate file messages so the PWA renders
      // them inline. Each file gets its own message_type='file' row.
      if (message.files && message.files.length > 0) {
        for (const file of message.files) {
          const meta: FileMeta = {
            url: server.persistOutboundFile(roomId, file),
            filename: file.filename,
            mime: guessMime(file.filename),
            size: file.data.length,
          };
          const stored = storeWebchatFileMessage(roomId, senderName, 'agent', file.filename, meta);
          server.broadcast(roomId, { type: 'message', ...stored });
        }
      }
      // Loop-back fan-out: re-enter the router so other wired agents in this
      // room can react to the producer's text (matches the "agents talk in
      // the room" mental model). Guarded by:
      //   • self-exclusion in router (the producer never re-engages itself)
      //   • prime-skip in router  (catch-all wirings don't fire on agent posts)
      //   • per-room rate limit   (circuit breaker against pathological chains)
      // Skipped when producer can't be resolved or there's no text payload
      // (files alone don't trigger — no @-mention to match against).
      if (adapterConfig && producer && text !== null && text.length > 0 && shouldLoopBack(roomId)) {
        const senderAgentGroupId = producer.id;
        const loopbackId =
          storedMessageId ?? `webchat-loopback-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        // Display attribution goes through `author.fullName` / `author.userName`
        // — fields the container-side formatter reads for sender labels but
        // which the permissions senderResolver ignores for identity (no
        // `author.userId` set → no fallback user row created). Using a plain
        // `sender` here would auto-create `webchat:<AgentName>` rows in the
        // users table on every loop-back, cluttering the permissions tab with
        // pseudo-users that have no roles or memberships.
        adapterConfig.onInbound(roomId, null, {
          id: loopbackId,
          kind: 'chat',
          content: {
            text,
            author: { fullName: senderName, userName: senderName },
            senderAgentGroupId,
          },
          timestamp: new Date().toISOString(),
          isMention: false,
          isGroup: true,
          senderAgentGroupId,
        });
      }
      return undefined;
    },

    async setTyping(platformId): Promise<void> {
      if (!server) return;
      server.broadcast(platformId, {
        type: 'typing',
        room_id: platformId,
        identity: senderForRoom(platformId),
        identity_type: 'agent',
        is_typing: true,
      });
    },
    async sendStatus(platformId, _threadId, status: AgentActivityStatus): Promise<void> {
      if (!server) return;
      // Redact before broadcast — tool targets (file paths, commands) and
      // reasoning summaries can echo secrets. The whole room sees this frame.
      const redact = (s: string | null): string | null => (s == null ? null : redactSensitiveData(s));
      server.broadcast(platformId, {
        type: 'status',
        room_id: platformId,
        event: status.kind,
        text: redact(status.text),
        detail: redact(status.detail),
      });
    },
  };

  return adapter;
}

// Per-room sliding-window rate limiter for agent-authored loop-back events.
// Circuit breaker for pathological chains that escape self-exclusion and
// prime-skip (e.g. two agents @-mentioning each other in their replies).
// 30 events / 60s per room — generous enough that legitimate "FOMC posts,
// Advisor replies, Executor confirms" multi-hop conversations sail through;
// tight enough that an infinite ping-pong gets clipped quickly.
const LOOPBACK_WINDOW_MS = 60_000;
const LOOPBACK_MAX_PER_WINDOW = 30;
const loopbackHistory = new Map<string, number[]>();

function shouldLoopBack(roomId: string): boolean {
  const now = Date.now();
  const cutoff = now - LOOPBACK_WINDOW_MS;
  const recent = (loopbackHistory.get(roomId) ?? []).filter((t) => t >= cutoff);
  if (recent.length >= LOOPBACK_MAX_PER_WINDOW) {
    log.warn('Webchat: loop-back rate limit hit, dropping agent fan-out', {
      roomId,
      windowMs: LOOPBACK_WINDOW_MS,
      cap: LOOPBACK_MAX_PER_WINDOW,
    });
    loopbackHistory.set(roomId, recent);
    return false;
  }
  recent.push(now);
  loopbackHistory.set(roomId, recent);
  return true;
}

/**
 * Exact lookup of an agent by id, returning the WebchatRoomAgent shape.
 * Used when delivery.ts threads the producing agent's id through; no
 * heuristic, no most-recently-active race. Returns null if the agent
 * vanished between produce-time and deliver-time (shouldn't happen in
 * practice — agents don't disappear mid-flight).
 */
function lookupAgentForMessage(agentGroupId: string): WebchatRoomAgent | null {
  const ag = getAgentGroup(agentGroupId);
  return ag ? { id: ag.id, name: ag.name, folder: ag.folder } : null;
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return null;
}

function agentDisplayName(): string {
  return process.env.AGENT_DISPLAY_NAME || 'Agent';
}

/**
 * Resolve the agent display name for a webchat room, preferring the actual
 * agent_groups.name over the generic env-default fallback. Single-agent
 * rooms get an exact answer; multi-agent rooms pick the most-recently-
 * active session (the producer of the in-flight response). Falls back to
 * the AGENT_DISPLAY_NAME env (or 'Agent') if no wired agents are found —
 * shouldn't happen in normal operation but keeps the deliver path safe.
 */
function senderForRoom(roomId: string): string {
  const agent = findActiveAgentForWebchatRoom(roomId);
  return agent?.name || agentDisplayName();
}

function guessMime(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() || '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
  };
  return map[ext] ?? 'application/octet-stream';
}

registerChannelAdapter('webchat', {
  factory: () => (isEnabled() ? createAdapter() : null),
});

// Fan-out cleanup: when an approval resolves (first responder approves/rejects),
// push an `approval_resolved` event to every other admin whose inbox got a copy
// of the card so their PWA hides the stale card in real time, then drop the
// index rows (dead pointers once the pending row is gone). Offline admins
// refetch on reconnect, so this is purely the live clear.
registerApprovalResolvedHandler((event) => {
  const approvalId = event.approval.approval_id;
  const resolvedByUserId = event.userId;
  const indexed = getWebchatApprovalInboxes(approvalId);
  for (const platformId of indexed) {
    const userId = userForApprovalInbox(platformId);
    if (userId) {
      // An approver inbox — clear the card from that admin's inbox.
      pushApprovalResolvedToUser(userId, approvalId, resolvedByUserId);
    } else {
      // The agent's room — flip the in-room card to resolved + clear live.
      markRoomApprovalResolved(approvalId, resolvedByUserId);
      broadcast(platformId, { type: 'approval_resolved', approvalId, resolvedBy: resolvedByUserId });
    }
  }
  if (indexed.length > 0) deleteWebchatApprovalIndex(approvalId);
});

// Surface an ACTIONABLE approval card into the requesting agent's own room (in
// addition to the per-approver inboxes), so admins can act without hunting in
// the Approvals inbox. The room is also indexed so the resolved-listener above
// clears the card on first response. Best-effort; webchat rooms only.
registerApprovalRequestedListener((e) => {
  const mg = e.session.messaging_group_id ? getMessagingGroup(e.session.messaging_group_id) : null;
  if (!mg || mg.channel_type !== 'webchat') return;
  const roomId = mg.platform_id;
  const card = storeWebchatApprovalCard(roomId, e.agentName ?? 'agent', {
    questionId: e.approvalId,
    title: e.title,
    question: e.question,
    options: e.options,
    action: e.action,
    approvers: e.approvers,
  });
  recordWebchatApproval(e.approvalId, roomId);
  broadcast(roomId, { type: 'message', ...card });
});
