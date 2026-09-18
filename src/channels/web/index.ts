/**
 * Web channel — embedded HTTP + WebSocket chat server with PWA frontend.
 *
 * Disabled by default. Enable with `WEB_ENABLED=true` in .env. The server
 * binds to `WEB_HOST` (default 127.0.0.1) on `WEB_PORT` (default 3100).
 *
 * Auth: bearer token (`WEB_TOKEN`) or localhost auto-pass — see auth.ts.
 * Identity → user_id: `web:owner` (bearer) / `web:local-owner`
 * (localhost). The first identity to authenticate is granted role='owner'.
 *
 * Schema lives in the central DB (see migration.ts): web_messages,
 * web_room_primes, web_settings, web_models, web_agent_models,
 * web_approvals_index. Rooms are `messaging_groups(channel_type='web')`.
 *
 * The adapter mirrors agent traffic into web_messages so the PWA has a
 * unified history view; routing/delivery still flows through the per-session
 * mailboxes like every other channel.
 */
// Side-effect import — must run before any transitive web import that
// reads `process.env.WEB_*` at module load (auth.ts, server.ts). See
// env-load.ts for the rationale.
import './env-load.js';
// Schema self-registration — must be imported before host init runs migrations.
import './migration.js';

import { randomUUID } from 'crypto';

import { log } from '../../log.js';
import { createMessagingGroup, getMessagingGroup, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { registerChannelAdapter } from '../channel-registry.js';
import type {
  AgentActivityStatus,
  ChannelAdapter,
  ChannelDefaults,
  ChannelSetup,
  OutboundMessage,
} from '../adapter.js';
import { redactSensitiveData } from './redact.js';
import { startWebServer, stopWebServer, type WebServer } from './server.js';
import {
  APPROVAL_INBOX_PREFIX,
  deleteWebApprovalIndex,
  findActiveAgentForWebRoom,
  getWebApprovalInboxes,
  getWebRoom,
  isApprovalInbox,
  markRoomApprovalResolved,
  recordWebApproval,
  storeWebApprovalCard,
  storeWebFileMessage,
  storeWebMessage,
  userForApprovalInbox,
  type FileMeta,
  type WebRoomAgent,
} from './db.js';
import { broadcast, pushApprovalResolvedToUser, pushApprovalToUser, recordTurnStart, recordTurnEnd } from './state.js';
import {
  registerApprovalRequestedListener,
  registerApprovalResolvedHandler,
} from '../../modules/approvals/primitive.js';
// Learning loop: the module registers propose_skill + its schema; the channel draws the cards.
import {
  registerSkillDraftProposedListener,
  registerSkillDraftResolvedListener,
} from '../../modules/learning/index.js';
import { markRoomSkillDraftResolved, storeWebSkillDraftCard } from './db.js';

export const CHANNEL_TYPE = 'web';

// Wiring-time defaults, declared so offline creation paths (setup, ncl,
// init-first-agent) don't fall back to the legacy static schema. Matches the
// values wireAgentToRoom / createWebRoom actually stamp: one agent per
// room answering everything (pattern '.'), a shared session (rooms aren't
// threaded), a public room policy (single-user install — access is the bearer
// token, not per-sender gating), and no mention concept (there is no @-mention
// in the web UI; the '.' pattern engages on every message regardless).
const WEB_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  mentions: 'never',
};

function isEnabled(): boolean {
  return process.env.WEB_ENABLED === 'true';
}

function createAdapter(): ChannelAdapter {
  let server: WebServer | null = null;

  const adapter: ChannelAdapter = {
    name: 'web',
    channelType: CHANNEL_TYPE,
    defaults: WEB_DEFAULTS,
    // A room is ONE conversation with one agent: no thread routing. The
    // router strips thread ids for supportsThreads=false adapters, so a room
    // maps to exactly one session.
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      server = await startWebServer({
        onInbound: (roomId, message) => {
          // onInbound is fire-and-forget from the transport's view; route it and
          // catch both sync throws and async rejections (config.onInbound is
          // typed void but returns routeInbound's promise), so a transient DB
          // error surfaces with context instead of a bare unhandledRejection
          // that silently loses the message.
          try {
            void Promise.resolve(config.onInbound(roomId, null, message)).catch((err: unknown) => {
              log.error('Web: inbound routing rejected', { roomId, err });
            });
          } catch (err) {
            log.error('Web: inbound routing threw', { roomId, err });
          }
        },
        onAction: (questionId, selectedOption, userId) => {
          config.onAction(questionId, selectedOption, userId);
        },
      });
      log.info('Web channel listening', { host: server.host, port: server.port, tls: server.tls });
    },

    async teardown(): Promise<void> {
      if (server) {
        await stopWebServer(server);
        server = null;
      }
    },

    isConnected(): boolean {
      return server !== null;
    },

    async openDM(handle: string): Promise<string> {
      // Owner approval inbox: a synthetic messaging_groups row keyed on the
      // handle, hidden from the room list. requestApproval() resolves it as
      // the delivery target; deliver() routes ask_question payloads to the
      // owner's connected tabs instead of storing them as chat messages.
      const platformId = `${APPROVAL_INBOX_PREFIX}${handle}`;
      if (!(await getMessagingGroupByPlatform('web', platformId))) {
        await createMessagingGroup({
          id: randomUUID(),
          channel_type: 'web',
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
      // synthetic approvals: platform_id push to the owner's connected
      // clients via WS. They never become chat messages.
      if (isApprovalInbox(platformId)) {
        const handle = platformId.slice(APPROVAL_INBOX_PREFIX.length);
        const approverUserId = `web:${handle}`;
        const content = message.content as Record<string, unknown> | string | undefined;
        if (content && typeof content === 'object' && content.type === 'ask_question') {
          // Stamp the approval into the web-side index so the PWA's
          // /api/approvals/pending query can find it later. (The questionId
          // field on the ask_question card IS pending_approvals.approval_id.)
          const approvalId = (content as { questionId?: unknown }).questionId;
          if (typeof approvalId === 'string' && approvalId.length > 0) {
            await recordWebApproval(approvalId, platformId);
          } else {
            log.warn('Web: ask_question card missing questionId — approval not indexed', { platformId });
          }
          pushApprovalToUser(approverUserId, content);
        } else {
          log.warn('Web: non-ask_question delivery to approval inbox dropped', {
            platformId,
            kind: typeof content === 'object' ? (content as { type?: string }).type : typeof content,
          });
        }
        return undefined;
      }

      const roomId = platformId;
      const room = await getWebRoom(roomId);
      if (!room) {
        log.warn('Web deliver: unknown room', { roomId });
        return undefined;
      }
      // One agent per room, so the room's wired agent IS the producer.
      const producer: WebRoomAgent | null = await findActiveAgentForWebRoom(roomId);
      const senderName = producer?.name ?? process.env.AGENT_DISPLAY_NAME ?? 'Agent';
      const text = extractText(message);
      if (text !== null && text.length > 0) {
        const stored = await storeWebMessage(roomId, senderName, 'agent', text);
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
          const stored = await storeWebFileMessage(roomId, senderName, 'agent', file.filename, meta);
          server.broadcast(roomId, { type: 'message', ...stored });
        }
      }
      return undefined;
    },

    async setTyping(platformId, _threadId, agentName): Promise<void> {
      if (!server) return;
      server.broadcast(platformId, {
        type: 'typing',
        room_id: platformId,
        identity: agentName || (await senderForRoom(platformId)),
        identity_type: 'agent',
        is_typing: true,
      });
    },

    async sendStatus(platformId, _threadId, status: AgentActivityStatus): Promise<void> {
      if (!server) return;
      // Redact before broadcast — tool targets (file paths, commands) and
      // reasoning summaries can echo secrets.
      const redact = (s: string | null | undefined): string | null => (s == null ? null : redactSensitiveData(s));
      // Track turn lifecycle so a client that re-joins mid-turn can replay the
      // bubble (status frames are ephemeral and room-scoped).
      const turnAgent = status.agentName ?? '';
      if (status.kind === 'start') recordTurnStart(platformId, turnAgent);
      else if (status.kind === 'done' || status.kind === 'stalled') recordTurnEnd(platformId, turnAgent);
      server.broadcast(platformId, {
        type: 'status',
        room_id: platformId,
        agent_name: status.agentName ?? null,
        event: status.kind,
        text: redact(status.text),
        detail: redact(status.detail),
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

/** The wired agent's display name, for typing frames that don't carry one. */
async function senderForRoom(roomId: string): Promise<string> {
  const agent = await findActiveAgentForWebRoom(roomId);
  return agent?.name || process.env.AGENT_DISPLAY_NAME || 'Agent';
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

// Surface an ACTIONABLE approval card into the requesting agent's own room
// (in addition to the owner's inbox), so the operator can act without hunting.
// The room is also indexed so the resolved-handler below clears the card on
// response. Best-effort; web rooms only.
// A staged skill draft becomes an actionable Keep/Discard card in the
// proposing agent's own room, so the person acts where the work happened.
registerSkillDraftProposedListener((e) => {
  void (async () => {
    const mg = await (e.session.messaging_group_id ? getMessagingGroup(e.session.messaging_group_id) : null);
    if (!mg || mg.channel_type !== 'web') return;
    const card = await storeWebSkillDraftCard(mg.platform_id, e.agentName || 'agent', {
      draftId: e.draftId,
      skillName: e.skillName,
      description: e.description,
      kind: e.kind,
      targetSkill: e.targetSkill,
      agentName: e.agentName,
    });
    await broadcast(mg.platform_id, { type: 'message', ...card });
  })().catch((err) => log.warn('Web: skill-draft card failed', { draftId: e.draftId, err }));
});

// Keep/Discard (or a supersede) flips the card in place, live on every open tab.
registerSkillDraftResolvedListener((e) => {
  void (async () => {
    const roomId = await markRoomSkillDraftResolved(e.draftId, e.outcome, e.by);
    if (!roomId) return;
    await broadcast(roomId, { type: 'skill_draft_resolved', draftId: e.draftId, outcome: e.outcome, resolvedBy: e.by });
  })().catch((err) => log.warn('Web: skill-draft card flip failed', { draftId: e.draftId, err }));
});

registerApprovalRequestedListener(async (e) => {
  const mg = await (e.session.messaging_group_id ? getMessagingGroup(e.session.messaging_group_id) : null);
  if (!mg || mg.channel_type !== 'web') return;
  const roomId = mg.platform_id;
  const card = await storeWebApprovalCard(roomId, e.agentName || 'agent', {
    questionId: e.approvalId,
    title: e.title,
    question: e.question,
    options: e.options,
    action: e.action,
  });
  await recordWebApproval(e.approvalId, roomId);
  await broadcast(roomId, { type: 'message', ...card });
});

// Resolution cleanup: flip the in-room card to resolved, clear the owner's
// inbox copy live on every open tab, then drop the index rows (dead pointers
// once the pending row is gone). Offline tabs refetch on reconnect.
registerApprovalResolvedHandler(async (event) => {
  const approvalId = event.approval.approval_id;
  const resolvedByUserId = event.userId;
  const indexed = await getWebApprovalInboxes(approvalId);
  for (const platformId of indexed) {
    const userId = userForApprovalInbox(platformId);
    if (userId) {
      pushApprovalResolvedToUser(userId, approvalId, resolvedByUserId);
    } else {
      await markRoomApprovalResolved(approvalId, resolvedByUserId);
      await broadcast(platformId, { type: 'approval_resolved', approvalId, resolvedBy: resolvedByUserId });
    }
  }
  if (indexed.length > 0) await deleteWebApprovalIndex(approvalId);
});

registerChannelAdapter('web', {
  factory: () => (isEnabled() ? createAdapter() : null),
  defaults: WEB_DEFAULTS,
});
