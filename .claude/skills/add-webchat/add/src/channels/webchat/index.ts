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
import { randomUUID } from 'crypto';

import { log } from '../../log.js';
import { createMessagingGroup, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { registerChannelAdapter } from '../channel-registry.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from '../adapter.js';
import { startWebchatServer, stopWebchatServer, type WebchatServer } from './server.js';
import {
  APPROVAL_INBOX_PREFIX,
  findActiveAgentForWebchatRoom,
  getWebchatRoom,
  isApprovalInbox,
  recordWebchatApproval,
  storeWebchatMessage,
  storeWebchatFileMessage,
  type FileMeta,
} from './db.js';
import { pushApprovalToUser } from './state.js';
import { startReconcileLoop, stopReconcileLoop } from './reconcile.js';

export const CHANNEL_TYPE = 'webchat';

function isEnabled(): boolean {
  return process.env.WEBCHAT_ENABLED === 'true';
}

function createAdapter(): ChannelAdapter {
  let server: WebchatServer | null = null;

  const adapter: ChannelAdapter = {
    name: 'webchat',
    channelType: CHANNEL_TYPE,
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
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
      // Resolve the producing agent's display name. For 1-agent rooms this
      // is exact. For multi-agent rooms it's the most-recently-active
      // session, which the agent-runner bumps right before writing the
      // response — reliable in practice, fuzzy under simultaneous replies
      // (acceptable: same agent's name stamping different replies in a
      // ~second window).
      const senderName = senderForRoom(roomId);
      const text = extractText(message);
      if (text !== null && text.length > 0) {
        const stored = storeWebchatMessage(roomId, senderName, 'agent', text);
        server.broadcast(roomId, { type: 'message', ...stored });
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
  };

  return adapter;
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
