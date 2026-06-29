/**
 * Webchat HTTP server — routes, auth, static PWA serve, WS upgrade.
 *
 * Endpoints:
 *   GET  /health                            health check, no auth
 *   GET  /api/auth/check                    verify token
 *   GET  /api/overview                      dashboard snapshot (owner: full,
 *                                             admin: graceful degrade)
 *   GET  /api/rooms                              list rooms
 *   POST /api/rooms                              create room + wire 1+ agents  [owner]
 *   DELETE /api/rooms/:id                        delete room + wirings (agents preserved)  [owner]
 *   GET  /api/rooms/:id/agents                   list agents wired to a room (incl. is_prime flag)
 *   POST /api/rooms/:id/agents                   wire an agent (existing or new)  [owner]
 *   DELETE /api/rooms/:id/agents/:agentId        unwire an agent (refuses last)  [owner]
 *   PUT  /api/rooms/:id/prime                    set { agentId } as the room's prime  [owner]
 *   DELETE /api/rooms/:id/prime                  clear the room's prime designation  [owner]
 *   GET  /api/rooms/:id/engage-mode              read room's engage default ('mention-only' | 'broadcast')
 *   PUT  /api/rooms/:id/engage-mode              set { mode } for the room  [owner]
 *   PUT  /api/rooms/:id/name                     rename the room (set { name })  [owner]
 *   GET  /api/rooms/:id/messages                 history (?after_id= catch-up, ?before_id= scroll-back)
 *   POST /api/rooms/:id/archive                  mark room archived (owner + admin) — global
 *   POST /api/rooms/:id/unarchive                clear global archive (owner + admin)
 *   POST /api/rooms/:id/hide                     hide room from this user's sidebar — per-user
 *   POST /api/rooms/:id/unhide                   un-hide for this user
 *   POST /api/rooms/:id/upload                   multipart upload
 *   POST /api/rooms/:id/upload/chunk             chunked upload
 *   GET  /api/files/:roomId/:filename            serve uploaded file
 *   GET  /api/agents                             list agent groups (filtered by caller's roles, incl. assigned_model_id)
 *   POST /api/agents                             create agent group + (optionally) wire a room  [owner]
 *   POST /api/agents/draft                       draft { name, instructions } from a freeform prompt  [owner]
 *   PUT  /api/agents/:id                         update agent group  [admin-of]
 *   DELETE /api/agents/:id                       delete agent group + filesystem  [admin-of]
 *   GET  /api/agents/:id/instructions            read CLAUDE.local.md
 *   PUT  /api/agents/:id/instructions            write CLAUDE.local.md  [admin-of]
 *   PUT  /api/agents/:id/model                   set { modelId } (or null to unassign) [owner]
 *   GET  /api/models                             list registered models
 *   POST /api/models                             register a new model (anthropic|ollama|openai-compatible)  [owner]
 *   POST /api/models/discover                    list models served by an endpoint (Ollama: /api/tags)  [owner]
 *   POST /api/models/probe                       paste a base URL, classify provider + list models  [owner]
 *   POST /api/models/bulk                        bulk-register many models in one call  [owner]
 *   PUT  /api/models/:id                         update a model  [owner]
 *   DELETE /api/models/:id                       delete a model (refuses if assigned; use ?force=1 to cascade-unassign)  [owner]
 *   GET  /api/push/vapid-public             VAPID public key
 *   POST /api/push/subscribe                add push subscription
 *   POST /api/push/unsubscribe              remove push subscription
 *   WS   /ws                                WebSocket chat (handled in ws.ts)
 *   GET  /*                                 PWA static files
 *
 * Cut from v1 for the v2 PR scope (referenced by their original v1 paths):
 *   - /api/agents (v1 token endpoint)   tokens are gone in v2; agents push via outbound.db
 *   - /api/routes                        v1 message_routes (v2 has agent_destinations)
 *   - /api/tasks                         scheduling lives in modules/scheduling
 *   - /api/bots/create-from-chat         v1 main-room flow; replaced by direct POST /api/agents
 *
 * Replaces v1's /api/stats: see /api/overview (re-shaped to v2 data model).
 */
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'http';
import { createServer as createHttpsServer } from 'https';
import { createHash, randomUUID } from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { getDb, hasTable } from '../../db/connection.js';
import { log } from '../../log.js';
import {
  deleteSessionDbState,
  findSessionsByAgentGroup,
  findSessionsByMessagingGroup,
  teardownSessionResources,
  type TeardownTarget,
} from '../../session-teardown.js';
import type { AgentGroup } from '../../types.js';
import {
  createAgentGroup,
  deleteAgentGroup,
  getAgentGroup,
  getAllAgentGroups,
  setAgentStatus,
  updateAgentGroup,
} from '../../db/agent-groups.js';
import { createMessagingGroupAgent, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { getPendingApproval, getSessionsByAgentGroup } from '../../db/sessions.js';
import { killContainer } from '../../container-runner.js';
import { restartAgentGroupContainers } from '../../container-restart.js';
import { initGroupFilesystem } from '../../group-init.js';
import {
  addMember as permsAddMember,
  removeMember as permsRemoveMember,
  getMembers as permsGetMembers,
} from '../../modules/permissions/db/agent-group-members.js';
import {
  deleteUser as permsDeleteUser,
  getAllUsers as permsGetAllUsers,
  getUser as permsGetUser,
  upsertUser as permsUpsertUser,
} from '../../modules/permissions/db/users.js';
import {
  getOwners as permsGetOwners,
  getUserRoles as permsGetUserRoles,
  grantRole as permsGrantRole,
  revokeRole as permsRevokeRole,
} from '../../modules/permissions/db/user-roles.js';
// Used by the symmetric "create destination on wire" step in
// wireAgentToWebchatRoom — see comment there.
import {
  createDestination,
  getDestinationByName,
  getDestinationByTarget,
  normalizeName,
} from '../../modules/agent-to-agent/db/agent-destinations.js';
import type { InboundMessage, OutboundFile } from '../adapter.js';
import {
  assertBearerTokenStrength,
  authenticateRequest,
  canonicalizeWebchatUserId,
  getAuthInfo,
  hasExplicitAuth,
  probeTailscaleHealth,
  requiresExplicitAuth,
  warnIfAutoProxyTrust,
} from './auth.js';
import {
  approvalInboxForUser,
  archiveRoom,
  assignModelToAgent,
  clearPrimeAgentForWebchatRoom,
  countAgentsForWebchatRoom,
  createWebchatModel,
  createWebchatRoom,
  deleteWebchatModel,
  deleteWebchatRoom,
  getAgentsAssignedToModel,
  getAgentsForWebchatRoom,
  getWebchatRoomsForAgent,
  getAllWebchatRooms,
  getArchivedRoomIds,
  getHiddenRoomIdsForUser,
  getAssignedModelForAgent,
  getPrimeAgentForWebchatRoom,
  getRoomEngageDefault,
  setRoomEngageDefault,
  isWebchatApprovalIndexedFor,
  getWebchatMessages,
  getWebchatMessagesAfterId,
  getWebchatMessagesBeforeId,
  searchWebchatMessages,
  getWebchatTopology,
  getWebchatModel,
  getWebchatPendingApprovalsForUser,
  getWebchatHandleUsers,
  getWebchatRoom,
  getWebchatUserHandle,
  sanitizeRoomName,
  updateWebchatRoomName,
  hideRoomForUser,
  listWebchatModels,
  pinRoomForUser,
  setPrimeAgentForWebchatRoom,
  setWebchatUserHandle,
  storeWebchatFileMessage,
  unarchiveRoom,
  unhideRoomForUser,
  unpinRoomForUser,
  unassignModelFromAgent,
  unwireAgentFromWebchatRoom,
  updateWebchatModel,
  type FileMeta,
  type WebchatModel,
  type WebchatModelKind,
  type WebchatRoomAgent,
} from './db.js';
import { DraftError, draftAgent } from './drafter.js';
import {
  KNOWN_ANTHROPIC_MODELS,
  discoverOllamaModels,
  probeEndpoint,
  validateModel,
  writeAgentSettingsForAssignedModel,
} from './models.js';
import { handleChunkedUpload, handleFileServe, handleMultipartUpload } from './files.js';
import { initWebPush, isValidPushEndpoint } from './push.js';
import { redactSensitiveData } from './redact.js';
import { hasAdminPrivilege, isAnyAdmin, isGlobalAdmin, isOwner, warnIfNoPermissionsModule } from './roles.js';
import { canAccessRoom, canArchiveRoom, filterRoomsForUser } from './access.js';
import {
  getRoomOauthAllowed,
  setRoomOauthAllowed,
  getEffectiveRoomMode,
  getRoomModeOverride,
  setRoomModeOverride,
  getCredentialsConfig,
  setCredentialsConfig,
  type CredentialsConfig,
  type CredentialMode,
} from './db.js';
import { listProviderContainerConfigNames } from '../../providers/provider-container-registry.js';

/** Auto-detect: the Codex provider is installed when it's registered a container config. */
function codexAvailable(): boolean {
  return listProviderContainerConfigNames().includes('codex');
}

// Cheap in-process guard against BYOK abuse: a per-identity min-interval on
// credential connects + mint starts (prevents rapid reconnect / spawn churn).
// The host is single-process, so a Map suffices; paired with a global cap on
// concurrent mint containers (MAX_ACTIVE_MINTS) enforced at the start endpoints.
const byokActionAt = new Map<string, number>();
const BYOK_MIN_INTERVAL_MS = 3000;
function byokRateLimited(userId: string, action: string): boolean {
  const key = `${userId}:${action}`;
  const now = Date.now();
  if (now - (byokActionAt.get(key) ?? 0) < BYOK_MIN_INTERVAL_MS) return true;
  byokActionAt.set(key, now);
  return false;
}

import { storeUserCredential, revokeUserCredential } from '../../modules/byok/onboard.js';
import {
  startClaudeMint,
  mintClaudeToken,
  startCodexMint,
  finishCodexMint,
  cancelMint,
  activeMintCount,
  MAX_ACTIVE_MINTS,
} from './oauth-mint.js';
import { realOnecliAdmin } from '../../modules/byok/onecli-admin.js';
import { userHasConnectedCredential, getUserCredential, listEnrolledGroups } from '../../modules/byok/db.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { broadcast, broadcastRooms } from './state.js';
import { setupWebSocket } from './ws.js';

const DEFAULT_PORT = 3100;
const DEFAULT_HOST = '127.0.0.1';

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export interface WebchatServerHooks {
  onInbound: (roomId: string, message: InboundMessage) => void;
  onAction: (questionId: string, selectedOption: string, userId: string) => void;
}

export interface WebchatServer {
  host: string;
  port: number;
  tls: boolean;
  http: HttpServer;
  broadcast: (roomId: string, payload: unknown) => void;
  persistOutboundFile: (roomId: string, file: OutboundFile) => string;
}

export async function startWebchatServer(hooks: WebchatServerHooks): Promise<WebchatServer> {
  const host = process.env.WEBCHAT_HOST || DEFAULT_HOST;
  const port = Number(process.env.WEBCHAT_PORT || DEFAULT_PORT);
  const tlsCert = process.env.WEBCHAT_TLS_CERT;
  const tlsKey = process.env.WEBCHAT_TLS_KEY;
  const publicDir = path.resolve(process.env.WEBCHAT_PUBLIC_DIR || 'public/webchat');

  // Refuse to start if the server is reachable from the network without any
  // explicit auth method configured. Localhost-only installs are fine.
  if (requiresExplicitAuth(host) && !hasExplicitAuth()) {
    throw new Error(
      `Webchat refusing to bind to ${host}:${port}: no auth method configured. ` +
        'Set WEBCHAT_TOKEN, WEBCHAT_TAILSCALE=true, or WEBCHAT_TRUSTED_PROXY_IPS, ' +
        'or bind to 127.0.0.1 instead.',
    );
  }
  // Refuse to start with a weak bearer token regardless of bind host.
  assertBearerTokenStrength();

  initWebPush();
  warnIfNoPermissionsModule();
  // Background probe — finishes before any client can hit /api/auth/info in
  // practice (boot completes synchronously to listen()), and the endpoint
  // tolerates the not-yet-probed state by treating it as unhealthy. No await:
  // failing slow shouldn't delay binding.
  void probeTailscaleHealth();

  if ((tlsCert && !tlsKey) || (!tlsCert && tlsKey)) {
    log.warn('Webchat: both WEBCHAT_TLS_CERT and WEBCHAT_TLS_KEY must be set for HTTPS — falling back to HTTP');
  }

  const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
    void handleHttp(req, res, hooks, publicDir).catch((err) => {
      log.error('Webchat HTTP handler threw', { err });
      if (!res.headersSent) {
        // Webchat is single-tenant + auth-gated; surface err.message so
        // operators get a real diagnostic instead of "Internal error". The
        // log line above still has the full stack for debugging.
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error', message }));
      }
    });
  };

  const tlsEnabled = Boolean(tlsCert && tlsKey);
  let httpServer: HttpServer;
  if (tlsCert && tlsKey) {
    httpServer = createHttpsServer(
      { cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) },
      requestHandler,
    ) as unknown as HttpServer;
    log.info('Webchat TLS enabled');
  } else {
    httpServer = createHttpServer(requestHandler);
  }

  setupWebSocket(httpServer, { onInbound: hooks.onInbound }, async (req) => {
    const auth = await authenticateRequest(req);
    if (!auth.ok) return null;
    return { userId: auth.userId, displayName: auth.displayName };
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', (err: NodeJS.ErrnoException) => {
      // EADDRINUSE on this port is almost always "another nanoclaw host is
      // already running for this checkout" — `pnpm run dev` doesn't single-
      // instance, and a Ctrl-C + restart can leave the old node behind. The
      // generic "Failed to start channel adapter" the registry would log is
      // unhelpful; surface the cause + recovery before rethrowing.
      if (err.code === 'EADDRINUSE') {
        log.fatal(
          `Webchat: port ${port} already in use — another nanoclaw host is likely running for this checkout. ` +
            `Recovery: pgrep -f "$(basename $(pwd)).*tsx" | xargs -r kill -9; sleep 2; pnpm run dev`,
          { host, port },
        );
      }
      reject(err);
    });
    httpServer.listen(port, host, () => {
      log.info('Webchat HTTP listening', { host, port, tls: tlsEnabled });
      warnIfAutoProxyTrust();
      resolve();
    });
  });

  return {
    host,
    port,
    tls: tlsEnabled,
    http: httpServer,
    broadcast: (roomId, payload) => {
      broadcast(roomId, payload as object);
    },
    persistOutboundFile: (roomId, file) => persistOutboundFile(roomId, file),
  };
}

export async function stopWebchatServer(server: WebchatServer): Promise<void> {
  await new Promise<void>((resolve) => {
    server.http.close(() => resolve());
  });
  log.info('Webchat HTTP stopped');
}

// ── HTTP request handler ─────────────────────────────────────────────────

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  hooks: WebchatServerHooks,
  publicDir: string,
): Promise<void> {
  // Same-origin-only CORS: echo Origin only when its host matches our Host.
  const origin = req.headers.origin;
  if (origin && req.headers.host) {
    try {
      if (new URL(origin).host === req.headers.host) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
    } catch {
      // malformed Origin — refuse to echo
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Security headers on every response (set via setHeader so later writeHead
  // calls merge rather than clobber them). CSP is the key one: this is a chat
  // app rendering LLM/markdown output, so even if the DOMPurify sanitizer is
  // ever bypassed, script-src 'self' stops injected <script>/handlers/eval from
  // executing — defense-in-depth behind the sanitizer. Everything is
  // same-origin and vendored (script-src/connect-src/font-src 'self'); the WS
  // is same-origin so 'self' covers it; img allows data:/blob: (thumbnails,
  // icon masks). style-src keeps 'unsafe-inline' for the handful of inline
  // style= attrs + JS el.style assignments — style injection is low-risk and
  // the script protection stays strict.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; " +
      "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');

  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';

  // Public endpoints (skip auth)
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (url.pathname === '/health' && method === 'GET') {
    return json(res, 200, { ok: true, uptime: process.uptime() });
  }
  // Pre-auth, public — the login screen reads this so it can tell the user
  // which methods are configured and whether tailscale is currently working
  // on the server. Returns only configured-method booleans + a coarse
  // tailscale-on-server health flag; no tokens, IPs, or detailed failure
  // reasons. See `getAuthInfo` for why this is safe to expose.
  if (url.pathname === '/api/auth/info' && method === 'GET') {
    return json(res, 200, getAuthInfo());
  }

  const auth = await authenticateRequest(req);
  if (!auth.ok) {
    return json(res, 401, { error: auth.reason });
  }
  const userId = auth.userId;
  const senderIdentity = auth.displayName;

  // ── Auth check ────────────────────────────────────────────────────────
  if (url.pathname === '/api/auth/check' && method === 'GET') {
    return json(res, 200, { ok: true, userId, identity: senderIdentity });
  }

  // ── Your @-mention handle (the slug others type to @-mention you) ──────
  if (url.pathname === '/api/me/handle' && method === 'GET') {
    return json(res, 200, { handle: getWebchatUserHandle(userId) ?? '' });
  }
  if (url.pathname === '/api/me/handle' && method === 'PUT') {
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { handle?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    const handle = typeof body.handle === 'string' ? body.handle.trim().toLowerCase() : '';
    const result = setWebchatUserHandle(userId, handle);
    if (!result.ok) {
      return result.reason === 'taken'
        ? json(res, 409, { error: 'That handle is already taken' })
        : json(res, 400, { error: 'Handle must be 1–32 characters: lowercase letters, numbers, and hyphens' });
    }
    return json(res, 200, { ok: true, handle });
  }

  // ── Overview ──────────────────────────────────────────────────────────
  if (url.pathname === '/api/overview' && method === 'GET') {
    return json(res, 200, await buildOverview(userId));
  }

  // ── Rooms ─────────────────────────────────────────────────────────────
  // Two creation paths exist for historical reasons and they are NOT
  // redundant: POST /api/agents is "agent-first" (the room is incidental,
  // 1:1 with the agent's folder), POST /api/rooms is "room-first" (the
  // room is the conversation unit and you wire 1+ agents to it). Both
  // converge on the same messaging_groups + messaging_group_agents shape.
  if (url.pathname === '/api/rooms' && method === 'GET') {
    const visible = filterRoomsForUser(userId, getAllWebchatRooms());
    const archivedSet = getArchivedRoomIds(); // global
    const hiddenSet = getHiddenRoomIdsForUser(userId); // per-user
    return json(
      res,
      200,
      visible.map((r) => ({
        ...r,
        archived: archivedSet.has(r.id),
        hidden: hiddenSet.has(r.id),
        canArchive: canArchiveRoom(userId, r.id),
      })),
    );
  }
  if (url.pathname === '/api/rooms' && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') {
      return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    }
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    return createRoomHandler(req, res);
  }

  const roomIdMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)$/);
  if (roomIdMatch && method === 'DELETE') {
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    return deleteRoomHandler(res, decodeURIComponent(roomIdMatch[1]));
  }

  const roomAgentsMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/agents$/);
  if (roomAgentsMatch && method === 'GET') {
    const roomId = decodeURIComponent(roomAgentsMatch[1]);
    if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
    if (!canAccessRoom(userId, roomId)) return json(res, 403, { error: 'Access denied' });
    const agents = getAgentsForWebchatRoom(roomId);
    const primeAgentId = getPrimeAgentForWebchatRoom(roomId);
    return json(
      res,
      200,
      agents.map((a) => ({ ...a, is_prime: a.id === primeAgentId })),
    );
  }
  // People you can @-mention in this room: anyone with a handle who can access
  // it (NOT limited to who's currently connected — a mention notifies on
  // return). Excludes the requester. Used by the composer's @ autocomplete.
  const roomMentionableMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/mentionable$/);
  if (roomMentionableMatch && method === 'GET') {
    const roomId = decodeURIComponent(roomMentionableMatch[1]);
    if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
    if (!canAccessRoom(userId, roomId)) return json(res, 403, { error: 'Access denied' });
    const people = getWebchatHandleUsers()
      .filter((u) => u.userId !== userId && canAccessRoom(u.userId, roomId))
      .map((u) => ({ handle: u.handle, name: u.displayName || u.handle }));
    return json(res, 200, people);
  }

  if (roomAgentsMatch && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') {
      return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    }
    // Permission is body-dependent (which agent is being wired), so it is
    // enforced inside the handler once the AgentRef is parsed. Owners may wire
    // anything; a scoped admin may wire an agent THEY administer to a room
    // they can access.
    return addAgentToRoomHandler(req, res, decodeURIComponent(roomAgentsMatch[1]), userId);
  }

  // ── BYOK: per-room credential mode (admin) ────────────────────────────────
  const roomCredModeMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/credential-mode$/);
  if (roomCredModeMatch && method === 'GET') {
    const roomId = decodeURIComponent(roomCredModeMatch[1]);
    if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
    if (!canAccessRoom(userId, roomId)) return json(res, 403, { error: 'Access denied' });
    // The per-room OVERRIDE ('inherit' when unset); the effective mode is what the
    // room actually runs (override, else the global default).
    return json(res, 200, {
      mode: getRoomModeOverride(roomId) ?? 'inherit',
      effectiveMode: getEffectiveRoomMode(roomId),
      defaultMode: getCredentialsConfig().defaultMode,
    });
  }
  if (roomCredModeMatch && method === 'PUT') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const roomId = decodeURIComponent(roomCredModeMatch[1]);
    if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
    // Owner, or an admin over ANY agent wired to this room.
    const allowed = isOwner(userId) || getAgentsForWebchatRoom(roomId).some((a) => hasAdminPrivilege(userId, a.id));
    if (!allowed) return json(res, 403, { error: 'Admin privilege required' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { mode?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    if (body.mode !== 'inherit' && body.mode !== 'disabled' && body.mode !== 'optional' && body.mode !== 'required') {
      return json(res, 400, { error: "mode must be 'inherit', 'disabled', 'optional', or 'required'" });
    }
    // 'inherit' clears the override so the room follows the global default.
    setRoomModeOverride(roomId, body.mode === 'inherit' ? null : body.mode);
    return json(res, 200, { ok: true, mode: body.mode });
  }

  // ── BYOK OAuth: per-room toggle allowing subscription tokens (admin) ───────
  const roomOauthMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/oauth-allowed$/);
  if (roomOauthMatch && method === 'GET') {
    const roomId = decodeURIComponent(roomOauthMatch[1]);
    if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
    if (!canAccessRoom(userId, roomId)) return json(res, 403, { error: 'Access denied' });
    return json(res, 200, { allowed: getRoomOauthAllowed(roomId) });
  }
  if (roomOauthMatch && method === 'PUT') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const roomId = decodeURIComponent(roomOauthMatch[1]);
    if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
    const allowed = isOwner(userId) || getAgentsForWebchatRoom(roomId).some((a) => hasAdminPrivilege(userId, a.id));
    if (!allowed) return json(res, 403, { error: 'Admin privilege required' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { allowed?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    if (typeof body.allowed !== 'boolean') return json(res, 400, { error: 'allowed must be a boolean' });
    setRoomOauthAllowed(roomId, body.allowed);
    return json(res, 200, { ok: true, allowed: body.allowed });
  }

  // ── BYOK: workspace credentials policy — accepted TYPES + default room mode ──
  // Read by anyone (the room UIs need it); only the owner can change it.
  if (url.pathname === '/api/webchat/credentials-config' && (method === 'GET' || method === 'PUT')) {
    if (method === 'GET') {
      return json(res, 200, { ...getCredentialsConfig(), codexAvailable: codexAvailable(), canEdit: isOwner(userId) });
    }
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    const patch: Partial<CredentialsConfig> = {};
    if (body.defaultMode !== undefined) {
      if (body.defaultMode !== 'disabled' && body.defaultMode !== 'optional' && body.defaultMode !== 'required')
        return json(res, 400, { error: "defaultMode must be 'disabled', 'optional', or 'required'" });
      patch.defaultMode = body.defaultMode as CredentialMode;
    }
    for (const k of ['allowAnthropicKey', 'allowClaudeOauth', 'allowOpenaiKey', 'allowCodexOauth'] as const) {
      if (body[k] === undefined) continue;
      if (typeof body[k] !== 'boolean') return json(res, 400, { error: `${k} must be a boolean` });
      patch[k] = body[k] as boolean;
    }
    // Codex types are inert until the provider is installed — refuse to enable them.
    if ((patch.allowCodexOauth || patch.allowOpenaiKey) && !codexAvailable())
      return json(res, 400, { error: 'Codex support isn’t installed yet — add it with /add-codex first.' });
    setCredentialsConfig(patch);
    return json(res, 200, { ...getCredentialsConfig(), codexAvailable: codexAvailable() });
  }

  // ── BYOK: a member connects / disconnects THEIR own Anthropic key ──────────
  // userId is the server-resolved caller — a user can only manage their own key.
  if (url.pathname === '/api/byok/credential' && (method === 'POST' || method === 'DELETE' || method === 'GET')) {
    const reqRoomId = method === 'GET' ? (url.searchParams.get('roomId') ?? '') : undefined; // POST/DELETE read roomId from the body below
    if (method === 'GET') {
      const roomId = decodeURIComponent(reqRoomId ?? '');
      if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
      if (!canAccessRoom(userId, roomId)) return json(res, 403, { error: 'Access denied' });
      const groups = getAgentsForWebchatRoom(roomId);
      // Effective mode (room override → global default). Credential TYPES are
      // workspace-wide (Credentials admin page); which ones apply here depends on
      // the room's provider (Claude vs Codex).
      const cfg = getCredentialsConfig();
      const provider = groups[0] && getContainerConfig(groups[0].id)?.provider === 'codex' ? 'codex' : 'claude';
      // Connection is now user-level (connect once → all same-provider rooms).
      const connected = userHasConnectedCredential(userId, provider);
      // Report the connected credential type so the UI shows the right banner.
      const credType = connected ? (getUserCredential(userId, provider)?.cred_type ?? null) : null;
      return json(res, 200, {
        connected,
        credType,
        provider,
        mode: getEffectiveRoomMode(roomId),
        oauthAllowed: provider === 'codex' ? cfg.allowCodexOauth : cfg.allowClaudeOauth,
        apiKeyAllowed: provider === 'codex' ? cfg.allowOpenaiKey : cfg.allowAnthropicKey,
      });
    }
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { roomId?: unknown; apiKey?: unknown; type?: unknown; token?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    const roomId = typeof body.roomId === 'string' ? body.roomId : '';
    if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
    if (!canAccessRoom(userId, roomId)) return json(res, 403, { error: 'Access denied' });
    const groups = getAgentsForWebchatRoom(roomId);
    if (groups.length === 0) return json(res, 400, { error: 'Room has no wired agent' });
    const provider = groups[0] && getContainerConfig(groups[0].id)?.provider === 'codex' ? 'codex' : 'claude';
    const credType = body.type === 'oauth_token' ? 'oauth_token' : 'api_key';
    const cfg = getCredentialsConfig();
    // Rate-limit connects (each recreates a vault secret + spawns onecli procs).
    if (method === 'POST' && byokRateLimited(userId, 'connect'))
      return json(res, 429, { error: 'Too many attempts — wait a moment and try again.' });
    try {
      if (method === 'POST' && credType === 'oauth_token') {
        // Gate 1: the workspace must accept this provider's subscriptions (Credentials page).
        if (!(provider === 'codex' ? cfg.allowCodexOauth : cfg.allowClaudeOauth))
          return json(res, 403, {
            error: `This workspace does not accept ${provider === 'codex' ? 'Codex (ChatGPT)' : 'Claude'} subscription (OAuth) connections.`,
          });
        const token = typeof body.token === 'string' ? body.token.trim() : '';
        if (provider === 'codex') {
          // Codex subscription = a whole auth.json (normally produced by the
          // browser mint; pasting it is a fallback). Require valid credential JSON.
          let ok = false;
          try {
            const parsed = JSON.parse(token) as Record<string, unknown>;
            ok = Boolean(parsed.tokens || parsed.OPENAI_API_KEY);
          } catch {
            ok = false;
          }
          if (!ok)
            return json(res, 400, {
              error: 'Expected a Codex auth.json — use “Connect with my ChatGPT subscription” instead of pasting.',
            });
        } else if (!/^sk-ant-oat/.test(token)) {
          return json(res, 400, {
            error: 'Expected a Claude subscription token from `claude setup-token` (sk-ant-oat…)',
          });
        }
        await storeUserCredential(realOnecliAdmin, userId, provider, token, 'oauth_token');
      } else if (method === 'POST') {
        if (!(provider === 'codex' ? cfg.allowOpenaiKey : cfg.allowAnthropicKey))
          return json(res, 403, {
            error: `This workspace does not accept ${provider === 'codex' ? 'OpenAI' : 'Anthropic'} API keys.`,
          });
        // API keys are gated by the room's effective mode (OAuth is workspace-wide
        // and allowed even in an OAuth-only 'disabled' room — see the spawn gate).
        // Credentials are user-level, so connecting via a disabled room would
        // otherwise silently enable BYOK in the member's other rooms.
        if (getEffectiveRoomMode(roomId) === 'disabled')
          return json(res, 403, { error: 'This room does not accept member API keys.' });
        const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
        // Codex: an OpenAI key (sk-…). Claude: an Anthropic key (sk-ant-…).
        if (provider === 'codex') {
          if (!/^sk-/.test(apiKey)) return json(res, 400, { error: 'Expected an OpenAI API key (sk-…)' });
        } else if (!/^sk-ant-/.test(apiKey)) {
          return json(res, 400, { error: 'Expected an Anthropic API key (sk-ant-…)' });
        }
        await storeUserCredential(realOnecliAdmin, userId, provider, apiKey, 'api_key');
      } else {
        // Disconnect: revoke the user-level credential + un-enroll every group.
        // Capture the enrolled groups BEFORE revoke (it clears them) so we can
        // also stop any running per-member container immediately — otherwise it
        // lingers (with its copy of the session) to the idle ceiling.
        const enrolledGroupIds = listEnrolledGroups(userId, provider).map((r) => r.agent_group_id);
        await revokeUserCredential(realOnecliAdmin, userId, provider);
        for (const gid of enrolledGroupIds) {
          for (const s of getSessionsByAgentGroup(gid)) {
            if (s.thread_id === userId) killContainer(s.id, 'BYOK credential disconnected');
          }
        }
      }
    } catch (err) {
      log.error('BYOK onboard/revoke failed', { userId, roomId, err: err instanceof Error ? err.message : err });
      return json(res, 502, { error: 'Credential setup failed — check OneCLI is running.' });
    }
    return json(res, 200, { ok: true });
  }

  // ── BYOK OAuth browser-mint: get a setup-token without a terminal ──────────
  // A member signs in to their Claude subscription entirely in the browser; the
  // server runs `claude setup-token` in a throwaway container, scrapes the URL,
  // takes the pasted code, captures the token, and stores it as the member's
  // user-level credential — the same storage the paste path uses, minus the
  // terminal. Same gates as the OAuth paste path: room access + OAuth opt-in.
  const byokMintMatch = url.pathname.match(/^\/api\/byok\/oauth\/(start|code|cancel)$/);
  if (byokMintMatch && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { roomId?: unknown; sessionId?: unknown; code?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    const step = byokMintMatch[1];
    if (step === 'cancel') {
      if (typeof body.sessionId === 'string') cancelMint(userId, body.sessionId);
      return json(res, 200, { ok: true });
    }
    const roomId = typeof body.roomId === 'string' ? body.roomId : '';
    if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
    if (!canAccessRoom(userId, roomId)) return json(res, 403, { error: 'Access denied' });
    if (!getCredentialsConfig().allowClaudeOauth)
      return json(res, 403, { error: 'This workspace does not accept Claude subscription (OAuth) connections.' });
    const groups = getAgentsForWebchatRoom(roomId);
    if (groups.length === 0) return json(res, 400, { error: 'Room has no wired agent' });
    try {
      if (step === 'start') {
        if (activeMintCount() >= MAX_ACTIVE_MINTS)
          return json(res, 429, { error: 'Too many sign-ins in progress — try again shortly.' });
        if (byokRateLimited(userId, 'mint-start'))
          return json(res, 429, { error: 'Too many attempts — wait a moment and try again.' });
        const { sessionId, url: signinUrl } = await startClaudeMint(userId);
        return json(res, 200, { sessionId, url: signinUrl });
      }
      // step === 'code': mint, then onboard.
      if (typeof body.sessionId !== 'string' || typeof body.code !== 'string')
        return json(res, 400, { error: 'sessionId and code required' });
      const token = await mintClaudeToken(userId, body.sessionId, body.code);
      await storeUserCredential(realOnecliAdmin, userId, 'claude', token, 'oauth_token');
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, 502, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── BYOK Codex browser-mint: connect a ChatGPT subscription without a terminal
  // `codex login --device-auth` runs in a throwaway container; the user enters
  // the pairing code at OpenAI's site (no code pasted back here). 'start' returns
  // the URL + code; 'finish' waits for the written auth.json and stores it as the
  // member's user-level Codex credential (→ an `openai` auth.json secret). Same
  // gates as the Claude mint: room access + the room's OAuth opt-in.
  const codexMintMatch = url.pathname.match(/^\/api\/byok\/codex\/(start|finish|cancel)$/);
  if (codexMintMatch && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { roomId?: unknown; sessionId?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    const step = codexMintMatch[1];
    if (step === 'cancel') {
      if (typeof body.sessionId === 'string') cancelMint(userId, body.sessionId);
      return json(res, 200, { ok: true });
    }
    const roomId = typeof body.roomId === 'string' ? body.roomId : '';
    if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
    if (!canAccessRoom(userId, roomId)) return json(res, 403, { error: 'Access denied' });
    if (!getCredentialsConfig().allowCodexOauth)
      return json(res, 403, {
        error: 'This workspace does not accept Codex (ChatGPT) subscription (OAuth) connections.',
      });
    const groups = getAgentsForWebchatRoom(roomId);
    if (groups.length === 0) return json(res, 400, { error: 'Room has no wired agent' });
    try {
      if (step === 'start') {
        if (activeMintCount() >= MAX_ACTIVE_MINTS)
          return json(res, 429, { error: 'Too many sign-ins in progress — try again shortly.' });
        if (byokRateLimited(userId, 'mint-start'))
          return json(res, 429, { error: 'Too many attempts — wait a moment and try again.' });
        const { sessionId, url: signinUrl, userCode } = await startCodexMint(userId);
        return json(res, 200, { sessionId, url: signinUrl, userCode });
      }
      // step === 'finish': wait for auth.json, then onboard.
      if (typeof body.sessionId !== 'string') return json(res, 400, { error: 'sessionId required' });
      const authJson = await finishCodexMint(userId, body.sessionId);
      await storeUserCredential(realOnecliAdmin, userId, 'codex', authJson, 'oauth_token');
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, 502, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  const roomAgentMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/agents\/([^/]+)$/);
  if (roomAgentMatch && method === 'DELETE') {
    const roomId = decodeURIComponent(roomAgentMatch[1]);
    const agentId = decodeURIComponent(roomAgentMatch[2]);
    // Owner can unwire any agent. A scoped admin may unwire an agent THEY
    // administer from a room they can access — they can never touch agents
    // they don't administer.
    if (!isOwner(userId) && !(canAccessRoom(userId, roomId) && hasAdminPrivilege(userId, agentId))) {
      return json(res, 403, { error: 'Admin privilege required' });
    }
    return removeAgentFromRoomHandler(res, roomId, agentId);
  }

  // ── Prime agent designation (room-scoped) ──
  const roomPrimeMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/prime$/);
  if (roomPrimeMatch && method === 'PUT') {
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    const roomId = decodeURIComponent(roomPrimeMatch[1]);
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { agentId?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    if (typeof body.agentId !== 'string' || !body.agentId.trim()) {
      return json(res, 400, { error: 'agentId required' });
    }
    return setRoomPrimeHandler(res, roomId, body.agentId.trim());
  }
  if (roomPrimeMatch && method === 'DELETE') {
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    return clearRoomPrimeHandler(res, decodeURIComponent(roomPrimeMatch[1]));
  }

  // ── Global archive (owner + admin) ──
  // Marks the room as closed-to-active-work for EVERYONE. Owners + any
  // admin (global or scoped admin of an agent wired to the room) can
  // toggle. Archive is presentation only — routing continues unchanged.
  // CSRF-guarded because it's a state-mutating POST.
  const roomArchiveMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(archive|unarchive)$/);
  if (roomArchiveMatch && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') {
      return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    }
    const roomId = decodeURIComponent(roomArchiveMatch[1]);
    if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
    if (!canArchiveRoom(userId, roomId)) return json(res, 403, { error: 'Admin only' });
    if (roomArchiveMatch[2] === 'archive') {
      archiveRoom(roomId, userId);
    } else {
      unarchiveRoom(roomId);
    }
    broadcastRooms();
    return json(res, 200, { ok: true });
  }

  // ── Per-user hide (sidebar preference, no auth beyond room access) ──
  // Any user with access to the room can hide it from THEIR sidebar.
  // Doesn't affect anyone else, routing, archive state, or anything
  // beyond that user's view. CSRF-guarded because it's state-mutating.
  const roomHideMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(hide|unhide)$/);
  if (roomHideMatch && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') {
      return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    }
    const roomId = decodeURIComponent(roomHideMatch[1]);
    if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
    if (!canAccessRoom(userId, roomId)) return json(res, 403, { error: 'Access denied' });
    if (roomHideMatch[2] === 'hide') {
      hideRoomForUser(userId, roomId);
    } else {
      unhideRoomForUser(userId, roomId);
    }
    broadcastRooms();
    return json(res, 200, { ok: true });
  }

  // ── Per-user pin (sidebar preference, no auth beyond room access) ──
  // Pins lift a room into the sticky group at the top of THIS user's sidebar.
  // Per-user; broadcastRooms re-sends each user their own annotated list, so the
  // pin syncs live across the user's other devices.
  const roomPinMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(pin|unpin)$/);
  if (roomPinMatch && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') {
      return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    }
    const roomId = decodeURIComponent(roomPinMatch[1]);
    if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
    if (!canAccessRoom(userId, roomId)) return json(res, 403, { error: 'Access denied' });
    if (roomPinMatch[2] === 'pin') {
      pinRoomForUser(userId, roomId);
    } else {
      unpinRoomForUser(userId, roomId);
    }
    broadcastRooms();
    return json(res, 200, { ok: true });
  }

  // ── Engage mode (room-scoped) ──
  // Controls what `recomputeEngagePatterns` rewrites un-primed wirings to:
  //   'mention-only' — agents fire only on explicit @-mention (no fallback).
  //   'broadcast'    — legacy: every wired agent answers every message.
  // The PWA never sends 'broadcast' (operator preference is mention-only-only),
  // but the API accepts both for symmetry with the DB schema.
  const roomEngageMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/engage-mode$/);
  if (roomEngageMatch && method === 'GET') {
    const roomId = decodeURIComponent(roomEngageMatch[1]);
    if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
    if (!canAccessRoom(userId, roomId)) return json(res, 403, { error: 'Access denied' });
    return json(res, 200, { mode: getRoomEngageDefault(roomId) });
  }
  if (roomEngageMatch && method === 'PUT') {
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    const roomId = decodeURIComponent(roomEngageMatch[1]);
    if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { mode?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    if (body.mode !== 'mention-only' && body.mode !== 'broadcast') {
      return json(res, 400, { error: "mode must be 'mention-only' or 'broadcast'" });
    }
    setRoomEngageDefault(roomId, body.mode);
    // Re-run pattern computation so the new mode is reflected in every wiring.
    // No-op when a prime is set (prime branch takes over). Cheap one-UPDATE-per-wiring.
    recomputeEngagePatterns(roomId);
    broadcastRooms();
    return json(res, 200, { ok: true, mode: body.mode });
  }

  // Rename a room (its messaging_groups.name). Owner-only; broadcastRooms pushes
  // the new title to every connected client live.
  const roomNameMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/name$/);
  if (roomNameMatch && method === 'PUT') {
    if (req.headers['x-webchat-csrf'] !== '1') {
      return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    }
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    const roomId = decodeURIComponent(roomNameMatch[1]);
    if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { name?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    const name = sanitizeRoomName(body.name);
    if (name === null) return json(res, 400, { error: 'name must be 1–80 characters' });
    updateWebchatRoomName(roomId, name);
    broadcastRooms();
    return json(res, 200, { ok: true, name });
  }

  // Room → agent → model topology for the explore view, scoped to the caller's
  // accessible rooms (and only the agents/models reachable from them).
  if (url.pathname === '/api/topology' && method === 'GET') {
    const rooms = filterRoomsForUser(userId, getAllWebchatRooms());
    // ALL agents the caller manages become columns/nodes (not just wired ones),
    // so unused agents show as orphans and can be wired from the matrix.
    const agents = listAgentsForUser(userId).map((a) => ({ id: a.id, name: a.name }));
    return json(res, 200, getWebchatTopology(rooms, agents));
  }

  // Full-text search across the caller's accessible rooms (FTS5). Scoped to
  // rooms the user can see — never leaks messages from other rooms.
  if (url.pathname === '/api/search' && method === 'GET') {
    const q = url.searchParams.get('q') ?? '';
    if (!q.trim()) return json(res, 200, { results: [] });
    const rooms = filterRoomsForUser(userId, getAllWebchatRooms());
    const nameById = new Map(rooms.map((r) => [r.id, r.name]));
    const hits = searchWebchatMessages(
      rooms.map((r) => r.id),
      q,
      50,
    );
    return json(res, 200, {
      results: hits.map((h) => ({
        id: h.id,
        roomId: h.room_id,
        roomName: nameById.get(h.room_id) ?? h.room_id,
        sender: h.sender,
        senderType: h.sender_type,
        snippet: redactSensitiveData(h.snippet),
        createdAt: h.created_at,
      })),
    });
  }

  const histMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/messages$/);
  if (histMatch && method === 'GET') {
    const room = getWebchatRoom(histMatch[1]);
    if (!room) return json(res, 404, { error: 'Room not found' });
    if (!canAccessRoom(userId, room.id)) return json(res, 403, { error: 'Access denied' });
    const afterId = url.searchParams.get('after_id');
    const beforeId = url.searchParams.get('before_id');
    const msgs = afterId
      ? getWebchatMessagesAfterId(room.id, afterId, 200)
      : beforeId
        ? getWebchatMessagesBeforeId(room.id, beforeId, 50)
        : getWebchatMessages(room.id, 100);
    return json(
      res,
      200,
      msgs.map((m) => ({ ...m, content: redactSensitiveData(m.content) })),
    );
  }

  // ── Upload (multipart / chunked) + serve ──────────────────────────────
  // Require a custom header on uploads so cross-origin form-POSTs (which are
  // CORS "simple requests" and skip preflight) can't auto-attach credentials
  // from a fronting proxy / cookie / Tailscale identity. The PWA sets this
  // header in authFetch().
  const uploadMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/upload$/);
  if (uploadMatch && method === 'POST') {
    const roomId = decodeURIComponent(uploadMatch[1]);
    const csrfOk = req.headers['x-webchat-csrf'] === '1';
    const accessOk = canAccessRoom(userId, roomId);
    log.info('Webchat upload (multipart) request', {
      roomId,
      userId,
      contentType: req.headers['content-type'],
      contentLength: req.headers['content-length'],
      csrfOk,
      accessOk,
    });
    if (!csrfOk) return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    if (!accessOk) return json(res, 403, { error: 'Access denied' });
    return handleMultipartUpload(req, res, roomId, senderIdentity, userId, hooks);
  }
  const chunkMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/upload\/chunk$/);
  if (chunkMatch && method === 'POST') {
    const roomId = decodeURIComponent(chunkMatch[1]);
    const csrfOk = req.headers['x-webchat-csrf'] === '1';
    const accessOk = canAccessRoom(userId, roomId);
    log.info('Webchat upload (chunked) request', {
      roomId,
      userId,
      contentType: req.headers['content-type'],
      contentLength: req.headers['content-length'],
      csrfOk,
      accessOk,
    });
    if (!csrfOk) return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    if (!accessOk) return json(res, 403, { error: 'Access denied' });
    return handleChunkedUpload(req, res, roomId, senderIdentity, userId, hooks);
  }
  const fileMatch = url.pathname.match(/^\/api\/files\/([^/]+)\/([^/]+)$/);
  if (fileMatch && method === 'GET') {
    const roomId = decodeURIComponent(fileMatch[1]);
    if (!canAccessRoom(userId, roomId)) return json(res, 403, { error: 'Access denied' });
    return handleFileServe(res, roomId, decodeURIComponent(fileMatch[2]));
  }

  // ── Agents (= agent groups) ─────────────────────────────────────────────
  if (url.pathname === '/api/agents' && method === 'GET') {
    const includeArchived = url.searchParams.get('includeArchived') === '1';
    return json(res, 200, listAgentsForUser(userId, includeArchived));
  }

  // POST /api/agents/draft must come BEFORE the /api/agents/:id pattern
  // (which would otherwise match 'draft' as an id) AND before the bare
  // /api/agents POST so the literal-path handlers stay distinct.
  if (url.pathname === '/api/agents/draft' && method === 'POST') {
    if (!isAnyAdmin(userId)) return json(res, 403, { error: 'Admin only' });
    if (req.headers['x-webchat-csrf'] !== '1') {
      return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    }
    return draftAgentHandler(req, res);
  }

  if (url.pathname === '/api/agents' && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') {
      return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    }
    if (!isAnyAdmin(userId)) return json(res, 403, { error: 'Admin only' });
    return createAgentHandler(req, res, userId);
  }

  const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (agentMatch && method === 'PUT') {
    const group = resolveAgent(decodeURIComponent(agentMatch[1]));
    if (!group) return json(res, 404, { error: 'Agent not found' });
    if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
    return updateAgentHandler(req, res, group.id);
  }
  if (agentMatch && method === 'DELETE') {
    const group = resolveAgent(decodeURIComponent(agentMatch[1]));
    if (!group) return json(res, 404, { error: 'Agent not found' });
    if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
    return deleteAgentHandler(res, group.id);
  }

  const instrMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/instructions$/);
  if (instrMatch && method === 'GET') {
    const group = resolveAgent(decodeURIComponent(instrMatch[1]));
    if (!group) return json(res, 404, { error: 'Agent not found' });
    if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
    return readInstructions(res, group.id);
  }
  if (instrMatch && method === 'PUT') {
    const group = resolveAgent(decodeURIComponent(instrMatch[1]));
    if (!group) return json(res, 404, { error: 'Agent not found' });
    if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
    return writeInstructions(req, res, group.id);
  }

  // GET the rooms an agent is wired to (agent-centric mirror of
  // GET /api/rooms/:id/agents). Read-only; writes go through the existing
  // owner-only POST/DELETE /api/rooms/:roomId/agents endpoints.
  const agentRoomsMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/rooms$/);
  if (agentRoomsMatch && method === 'GET') {
    const group = resolveAgent(decodeURIComponent(agentRoomsMatch[1]));
    if (!group) return json(res, 404, { error: 'Agent not found' });
    if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
    return json(res, 200, getWebchatRoomsForAgent(group.id));
  }

  // ── Per-agent model assignment ─────────────────────────────────────────
  const agentModelMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/model$/);
  if (agentModelMatch && method === 'PUT') {
    const group = resolveAgent(decodeURIComponent(agentModelMatch[1]));
    if (!group) return json(res, 404, { error: 'Agent not found' });
    if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
    return assignAgentModelHandler(req, res, group.id);
  }

  // ── Lifecycle status (active | paused | archived) ──────────────────────
  const agentStatusMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/status$/);
  if (agentStatusMatch && method === 'PUT') {
    if (req.headers['x-webchat-csrf'] !== '1') {
      return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    }
    const group = resolveAgent(decodeURIComponent(agentStatusMatch[1]));
    if (!group) return json(res, 404, { error: 'Agent not found' });
    if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
    return setAgentStatusHandler(req, res, group.id);
  }

  // ── Models ────────────────────────────────────────────────────────────
  if (url.pathname === '/api/models' && method === 'GET') {
    return json(res, 200, listModelsForUI());
  }
  if (url.pathname === '/api/models' && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') {
      return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    }
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    return createModelHandler(req, res);
  }
  if (url.pathname === '/api/models/discover' && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') {
      return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    }
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    return discoverModelsHandler(req, res);
  }
  if (url.pathname === '/api/models/probe' && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') {
      return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    }
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    return probeModelsHandler(req, res);
  }
  if (url.pathname === '/api/models/bulk' && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') {
      return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    }
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    return bulkCreateModelsHandler(req, res);
  }
  const modelIdMatch = url.pathname.match(/^\/api\/models\/([^/]+)$/);
  if (modelIdMatch && method === 'PUT') {
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    return updateModelHandler(req, res, decodeURIComponent(modelIdMatch[1]));
  }
  if (modelIdMatch && method === 'DELETE') {
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    const force = url.searchParams.get('force') === '1';
    return deleteModelHandler(res, decodeURIComponent(modelIdMatch[1]), force);
  }

  // ── Approvals inbox (per-user) ────────────────────────────────────────
  if (url.pathname === '/api/approvals/pending' && method === 'GET') {
    const rows = getWebchatPendingApprovalsForUser(userId);
    return json(
      res,
      200,
      rows.map((r) => ({
        questionId: r.approval_id,
        action: r.action,
        title: r.title,
        options: JSON.parse(r.options_json),
        // Payload is action-specific (apt list / mcp config / etc). The PWA
        // renders it as a JSON-pretty block so the user can review what
        // they're approving without us having to ship per-action templates.
        payload: safeParseJson(r.payload),
        created_at: r.created_at,
      })),
    );
  }
  const approveMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/respond$/);
  if (approveMatch && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') {
      return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    }
    const approvalId = decodeURIComponent(approveMatch[1]);
    const pending = getPendingApproval(approvalId);
    if (!pending || pending.status !== 'pending') {
      return json(res, 404, { error: 'Approval not found or already resolved' });
    }
    // Authorize against the webchat-owned index, not the pending_approvals row
    // columns — trunk's `requestApproval` doesn't populate channel_type /
    // platform_id, so those are NULL on every webchat-routed approval. Same
    // constraint that drove the read path's JOIN against webchat_approvals_index.
    const expectedPlatformId = approvalInboxForUser(userId);
    if (!expectedPlatformId || !isWebchatApprovalIndexedFor(approvalId, expectedPlatformId)) {
      return json(res, 403, { error: 'Not the intended approver for this request' });
    }
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { value?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    const value = typeof body.value === 'string' ? body.value : '';
    if (value !== 'approve' && value !== 'reject') {
      return json(res, 400, { error: 'value must be "approve" or "reject"' });
    }
    // Hand off to the existing approvals plumbing — onAction → response
    // handler → registered approval handler. We don't update the row here;
    // handleApprovalsResponse owns the lifecycle (status update + delete).
    hooks.onAction(approvalId, value, userId);
    return json(res, 200, { ok: true });
  }

  // ── Permissions ───────────────────────────────────────────────────────
  // Owners see/do everything. Scoped/global admins can view the permissions
  // panel and grant/revoke *member* access on groups they administer; role
  // grants (admin/owner) and user deletion stay owner-only since they
  // escalate privilege. The /api/users view is scoped per-caller below.
  if (url.pathname === '/api/users' && method === 'GET') {
    if (!isAnyAdmin(userId)) return json(res, 403, { error: 'Admin only' });
    return json(res, 200, listUsersWithPermissions(userId));
  }
  const userIdMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userIdMatch && method === 'DELETE') {
    if (req.headers['x-webchat-csrf'] !== '1') {
      return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    }
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    return deleteUserHandler(res, decodeURIComponent(userIdMatch[1]), userId);
  }
  if (url.pathname === '/api/permissions/grant' && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') {
      return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    }
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { userId?: unknown; kind?: unknown; agentGroupId?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    const granted = checkMemberGrantAuth(userId, body.kind, body.agentGroupId);
    if (granted) return json(res, 403, granted);
    return grantPermissionHandler(res, body, userId);
  }
  if (url.pathname === '/api/permissions/revoke' && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') {
      return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    }
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { userId?: unknown; kind?: unknown; agentGroupId?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    const revoked = checkMemberGrantAuth(userId, body.kind, body.agentGroupId);
    if (revoked) return json(res, 403, revoked);
    return revokePermissionHandler(res, body);
  }

  // ── Push ──────────────────────────────────────────────────────────────
  if (url.pathname === '/api/push/vapid-public' && method === 'GET') {
    const pub = process.env.WEBCHAT_VAPID_PUBLIC_KEY || '';
    if (!pub) return json(res, 501, { error: 'WEBCHAT_VAPID_PUBLIC_KEY not set' });
    return json(res, 200, { key: pub });
  }
  if (url.pathname === '/api/push/subscribe' && method === 'POST') {
    return pushSubscribe(req, res, userId);
  }
  if (url.pathname === '/api/push/unsubscribe' && method === 'POST') {
    return pushUnsubscribe(req, res, userId);
  }

  // ── Static PWA ────────────────────────────────────────────────────────
  if (method === 'GET' && servePwa(req, res, publicDir)) return;

  return json(res, 404, { error: 'Not found' });
}

// ── Helpers ──────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// Cap JSON request bodies at 1 MB. Larger payloads use the chunked upload
// endpoint, which has its own (higher) cap in files.ts.
const MAX_JSON_BODY_BYTES = 1024 * 1024;

class BodyTooLargeError extends Error {
  constructor() {
    super('Request body too large');
  }
}

function readBody(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new BodyTooLargeError());
        return;
      }
      body += d;
    });
    req.on('end', () => resolve(body));
    req.on('error', (err) => reject(err));
  });
}

async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  try {
    return await readBody(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      json(res, 413, { error: 'Request body too large' });
      return null;
    }
    throw err;
  }
}

// Derive the service-worker cache name from a hash of every served asset
// (except sw.js itself), so the cache busts exactly when an asset changes —
// replacing the old hand-bumped `nanoclaw-chat-vNNN` constant that conflicted
// on every webchat branch. Sorted for determinism; recomputed per sw.js fetch,
// which is an infrequent request, so no memoization is needed (and none can go
// stale). Returns a stable fallback if the directory can't be read.
export function computeSwCacheVersion(publicDir: string): string {
  let entries: string[];
  try {
    entries = fs.readdirSync(publicDir).sort();
  } catch {
    return 'nanoclaw-chat-dev';
  }
  const hash = createHash('sha256');
  for (const name of entries) {
    if (name === 'sw.js') continue;
    const fp = path.join(publicDir, name);
    try {
      if (!fs.statSync(fp).isFile()) continue;
      hash.update(name);
      hash.update(fs.readFileSync(fp));
    } catch {
      /* skip unreadable entries */
    }
  }
  return 'nanoclaw-chat-' + hash.digest('hex').slice(0, 12);
}

function servePwa(req: IncomingMessage, res: ServerResponse, publicDir: string): boolean {
  let urlPath = req.url?.split('?')[0] ?? '/';
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(publicDir, urlPath);
  if (!filePath.startsWith(publicDir + path.sep) && filePath !== publicDir) {
    res.writeHead(403);
    res.end();
    return true;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const ext = path.extname(filePath);
  const basename = path.basename(filePath);
  const contentType =
    basename === 'manifest.json' ? 'application/manifest+json' : STATIC_MIME[ext] || 'application/octet-stream';
  // sw.js carries a `__CACHE_VERSION__` placeholder; substitute the derived
  // asset hash so the service worker's cache name tracks asset content.
  if (basename === 'sw.js') {
    const body = fs.readFileSync(filePath, 'utf8').replace('__CACHE_VERSION__', computeSwCacheVersion(publicDir));
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    res.end(body);
    return true;
  }
  // `no-cache` = browser MAY cache but must revalidate before reuse. Without
  // this we sent no caching headers; both the browser and any reverse proxy
  // in front (Azure App Service, Cloudflare, nginx) happily held stale
  // CSS/JS/HTML across deploys, breaking PWA updates. The SW's network-first
  // path benefits from this immediately; cache-first served assets still
  // need an SW reinstall (bump the CACHE constant in sw.js) to evict.
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
  });
  res.end(fs.readFileSync(filePath));
  return true;
}

function persistOutboundFile(roomId: string, file: OutboundFile): string {
  const safeRoom = roomId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeFile = file.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const dir = path.join(DATA_DIR, 'webchat', 'uploads', safeRoom);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = Date.now();
  const filename = `${stamp}-${safeFile}`;
  fs.writeFileSync(path.join(dir, filename), file.data);
  return `/api/files/${encodeURIComponent(safeRoom)}/${filename}`;
}

// ── Agents (agent groups) ──

/** Slugify an agent/room name into a safe folder + platform_id. */
function nameToFolder(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Generate a new agent_groups.id that's safe to pass to OneCLI's
 * `ensureAgent({ identifier })` — that endpoint validates against
 * `[a-z][a-z0-9-]{0,49}` (must start with a letter, lowercase, ≤50
 * chars). Bare `randomUUID()` fails when the first hex char is a
 * digit (~10/16 of the time), and the failure mode is silent: the
 * host's container-runner spawns retry forever in host-sweep but
 * the user just sees the chat agent stuck "thinking" with no reply.
 *
 * Prefix with `a` so the leading char is always a letter; the rest
 * of the UUID is already `[0-9a-f-]+`. Total length 37 chars.
 */
function newAgentGroupId(): string {
  return 'a' + randomUUID();
}

/**
 * Wire an existing agent to a webchat room. Idempotent — calling twice
 * doesn't duplicate the messaging_groups / messaging_group_agents rows.
 * The room id is the agent's `folder` by convention (so each agent has a
 * 1:1 default room with a stable, predictable id).
 *
 * Exported so the webchat lifecycle subscriber (in `index.ts`) can
 * provision rooms for agents created via the a2a `create_agent` tool.
 */
export function wireAgentToWebchatRoom(roomName: string, platformId: string, agentGroupId: string): void {
  // db.createWebchatRoom is itself idempotent on (channel_type='webchat', platform_id).
  createWebchatRoom(roomName, platformId);
  const mg = getMessagingGroupByPlatform('webchat', platformId);
  if (!mg) throw new Error(`Webchat room provisioning failed: ${platformId}`);
  const existing = getDb()
    .prepare(
      `SELECT 1 FROM messaging_group_agents
       WHERE messaging_group_id = ? AND agent_group_id = ? LIMIT 1`,
    )
    .get(mg.id, agentGroupId);
  if (existing) return;
  createMessagingGroupAgent({
    id: randomUUID(),
    messaging_group_id: mg.id,
    agent_group_id: agentGroupId,
    engage_mode: 'pattern',
    engage_pattern: '.', // always engage — webchat rooms wire to a single agent by default
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: new Date().toISOString(),
  });
  // Mirror the unwire teardown (see `unwireAgentFromWebchatRoom` in db.ts):
  // create an `agent_destinations` row so the agent has an ACL entry it can
  // address this room with. Without this, an agent wired into a second room
  // receives inbound messages from it (via the wiring above) but has no
  // destination to reply to — its destinations list stays anchored to its
  // original room and every reply routes there, regardless of which room
  // the request came from. Idempotent on (agent_group_id, target).
  //
  // local_name uses normalizeName(platformId) — a UUID — to guarantee
  // uniqueness within the agent's namespace (PK is agent_group_id, local_name).
  // Using the room's display name would be friendlier but collides if two
  // rooms share a name; backfill (`module-agent-to-agent-destinations.ts`)
  // handles that case with -2/-3 suffixes — worth aligning in a follow-up.
  if (hasTable(getDb(), 'agent_destinations')) {
    const existing = getDestinationByTarget(agentGroupId, 'channel', mg.id);
    if (!existing) {
      createDestination({
        agent_group_id: agentGroupId,
        local_name: normalizeName(platformId),
        target_type: 'channel',
        target_id: mg.id,
        created_at: new Date().toISOString(),
      });
    }

    // Co-resident a2a destinations: any agents already wired to this room
    // should be addressable by the new agent, and vice versa. PWA "+ Add
    // agent" only creates the room wiring above; without this block, agents
    // sharing a room can't `<message to="…">` each other by name — the main
    // agent in the room sees the newcomer as inbound traffic but has no
    // local_name to address it back. The agent's typical workaround
    // (spawning its own via `create_agent`) results in a duplicate agent.
    // The `create_agent` MCP tool already creates bidirectional rows; this
    // brings the PWA "add agent to room" path to parity.
    const peers = getDb()
      .prepare(
        `SELECT ag.id, ag.folder FROM messaging_group_agents mga
         JOIN agent_groups ag ON ag.id = mga.agent_group_id
         WHERE mga.messaging_group_id = ? AND mga.agent_group_id != ?`,
      )
      .all(mg.id, agentGroupId) as { id: string; folder: string }[];
    const newAgent = getDb().prepare(`SELECT folder FROM agent_groups WHERE id = ?`).get(agentGroupId) as
      | { folder: string }
      | undefined;
    for (const peer of peers) {
      ensureA2aDestination(agentGroupId, peer.id, peer.folder);
      if (newAgent) ensureA2aDestination(peer.id, agentGroupId, newAgent.folder);
    }
  }
  // Wirings changed — recompute engage patterns in case this room has a
  // prime configured. No-op when no prime is set (leaves the default '.').
  recomputeEngagePatterns(platformId);
}

/**
 * Idempotently create an a2a destination `owner → target` named after
 * `targetFolder`. If that name collides with an existing destination on the
 * owner (typical: same-named channel destination for a room sharing the
 * agent's folder slug), fall back to `<folder>-agent`. If both are taken,
 * log + skip — the operator can add a hand-picked name via `ncl destinations
 * add` if they want one. Always skips if an a2a destination to this target
 * already exists (irrespective of name).
 */
function ensureA2aDestination(ownerAgentId: string, targetAgentId: string, targetFolder: string): void {
  if (getDestinationByTarget(ownerAgentId, 'agent', targetAgentId)) return;
  const base = normalizeName(targetFolder);
  const candidates = [base, `${base}-agent`];
  for (const name of candidates) {
    if (!getDestinationByName(ownerAgentId, name)) {
      createDestination({
        agent_group_id: ownerAgentId,
        local_name: name,
        target_type: 'agent',
        target_id: targetAgentId,
        created_at: new Date().toISOString(),
      });
      return;
    }
  }
  log.warn('Could not auto-create a2a destination — local_name collisions; operator may set one manually', {
    ownerAgentId,
    targetAgentId,
    tried: candidates,
  });
}

/**
 * Recompute `messaging_group_agents.engage_pattern` for every wiring on a
 * room based on the current prime designation.
 *
 *   - No prime configured  → all wirings get '.' (default: every agent
 *     engages on every message — current behavior pre-prime).
 *   - Prime configured     → prime gets a negative-lookahead pattern that
 *     matches text NOT mentioning any other wired agent's folder; each
 *     non-prime agent gets a positive `\B@<folder>\b` pattern.
 *
 * Match key is the agent's `folder` (already slugified to `[a-z0-9-]+` by
 * `nameToFolder`, no regex special chars to escape). Word-boundary on the
 * left is `\B@` so `@alice` matches at start-of-string and after spaces but
 * not inside an email like `foo@alice.com`.
 *
 * Idempotent and cheap (one row per wiring, single UPDATE each). Called from
 * every wiring-change path: wireAgentToWebchatRoom, unwireAgentFromWebchatRoom,
 * and the prime PUT/DELETE handlers.
 */
export function recomputeEngagePatterns(roomId: string): void {
  const mg = getMessagingGroupByPlatform('webchat', roomId);
  if (!mg) return;
  const wirings = getDb()
    .prepare(
      `SELECT mga.id, mga.agent_group_id, ag.folder
       FROM messaging_group_agents mga
       JOIN agent_groups ag ON ag.id = mga.agent_group_id
       WHERE mga.messaging_group_id = ?`,
    )
    .all(mg.id) as { id: string; agent_group_id: string; folder: string }[];

  const primeAgentId = getPrimeAgentForWebchatRoom(roomId);
  // If the configured prime isn't actually wired (stale row), treat as
  // un-configured. Caller is responsible for cleaning up the stale row.
  const validPrime = primeAgentId && wirings.some((w) => w.agent_group_id === primeAgentId);

  const update = getDb().prepare(`UPDATE messaging_group_agents SET engage_pattern = ? WHERE id = ?`);

  if (!validPrime) {
    // No prime — fall through to the room's engage_default. 'broadcast' is
    // the legacy behavior (every agent responds to every message). 'mention-only'
    // makes the room silent until an agent is explicitly @-mentioned, which is
    // the right model for a many-agent shared room where catch-all responses
    // would just be noise.
    const engageDefault = getRoomEngageDefault(roomId);
    if (engageDefault === 'mention-only') {
      for (const w of wirings) update.run(`\\B@${ciFolderToken(w.folder)}\\b`, w.id);
    } else {
      for (const w of wirings) update.run('.', w.id);
    }
    return;
  }

  const otherFolders = wirings.filter((w) => w.agent_group_id !== primeAgentId).map((w) => w.folder);
  for (const w of wirings) {
    let pattern: string;
    if (w.agent_group_id === primeAgentId) {
      // Lookahead is anchored to the start so it scans the whole message.
      // No other agents → prime engages on everything (back to '.').
      pattern = otherFolders.length > 0 ? `^(?!.*\\B@(${otherFolders.map(ciFolderToken).join('|')})\\b)` : '.';
    } else {
      pattern = `\\B@${ciFolderToken(w.folder)}\\b`;
    }
    update.run(pattern, w.id);
  }
}

/**
 * Build a case-insensitive regex token for a slug folder by replacing each
 * letter with `[Aa]`-style char class. Hyphens and digits stay as-is. We do
 * this inline because the v2 router calls `new RegExp(pattern)` with no
 * flags, and there's no portable way to set the case-insensitive flag from
 * inside the pattern string (V8 does support `(?i:...)` since ECMAScript
 * 2025, but nothing else does — char classes are bulletproof).
 *
 * Example: 'alice-helper' → '[Aa][Ll][Ii][Cc][Ee]-[Hh][Ee][Ll][Pp][Ee][Rr]'
 */
function ciFolderToken(folder: string): string {
  let out = '';
  for (const ch of folder) {
    if (/[a-zA-Z]/.test(ch)) {
      out += `[${ch.toLowerCase()}${ch.toUpperCase()}]`;
    } else {
      out += ch;
    }
  }
  return out;
}

// ── Overview / dashboard ──────────────────────────────────────────────

interface OverviewSnapshot {
  restricted: boolean;
  health: { uptime: number; container_runtime_ok: boolean };
  agents: { total: number; visible: number };
  sessions: { active: number; total: number };
  messages: { webchat_24h: number };
  channels: Record<string, number>;
  system: {
    memory_used_pct: number;
    memory_used_gb: number;
    memory_total_gb: number;
    load_avg: number[];
    cpus: number;
    platform: string;
  } | null;
  ollama: { ok: boolean; host: string; models?: string[] } | null;
  recent_agents: Array<{
    id: string;
    name: string;
    folder: string;
    room_id: string | null;
  }>;
  busiest_rooms: Array<{ id: string; name: string; count: number }> | null;
  active_containers: number | null;
}

const ACTIVE_SESSION_WINDOW_MS = 5 * 60 * 1000;

async function buildOverview(userId: string): Promise<OverviewSnapshot> {
  const db = getDb();
  const ownerCaller = isOwner(userId);

  // Visible agent count — owners see everything; admins see ones they
  // explicitly admin (matches how /api/agents filters).
  const allAgents = db.prepare(`SELECT id FROM agent_groups`).all() as { id: string }[];
  const visibleAgents = ownerCaller ? allAgents : allAgents.filter((a) => hasAdminPrivilege(userId, a.id));

  // Sessions — `last_active` is an ISO timestamp string.
  const fiveMinAgo = new Date(Date.now() - ACTIVE_SESSION_WINDOW_MS).toISOString();
  const sessionsTotal = (db.prepare(`SELECT COUNT(*) AS c FROM sessions`).get() as { c: number }).c;
  const sessionsActive = (
    db.prepare(`SELECT COUNT(*) AS c FROM sessions WHERE last_active > ?`).get(fiveMinAgo) as { c: number }
  ).c;

  // Webchat messages in the last 24h — cheap, single table.
  const yesterdayMs = Date.now() - 86_400_000;
  const messages24h = (
    db.prepare(`SELECT COUNT(*) AS c FROM webchat_messages WHERE created_at > ?`).get(yesterdayMs) as { c: number }
  ).c;

  // Channel breakdown — count of messaging_groups per channel_type.
  const channelRows = db
    .prepare(`SELECT channel_type, COUNT(*) AS c FROM messaging_groups GROUP BY channel_type`)
    .all() as { channel_type: string; c: number }[];
  const channels: Record<string, number> = {};
  for (const row of channelRows) channels[row.channel_type] = row.c;

  // Recent agents — last 5 created. Restricted set when not owner.
  const recentLimit = 5;
  const visibleIds = new Set(visibleAgents.map((a) => a.id));
  const recentSql = ownerCaller
    ? `SELECT id, name, folder, created_at FROM agent_groups ORDER BY created_at DESC LIMIT ${recentLimit}`
    : `SELECT id, name, folder, created_at FROM agent_groups ORDER BY created_at DESC`;
  const recentRaw = db.prepare(recentSql).all() as { id: string; name: string; folder: string; created_at: string }[];
  const recentFiltered = ownerCaller ? recentRaw : recentRaw.filter((r) => visibleIds.has(r.id)).slice(0, recentLimit);
  const recentAgents = recentFiltered.map((r) => {
    const room = getWebchatRoom(r.folder);
    return {
      id: r.id,
      name: r.name,
      folder: r.folder,
      room_id: room ? room.id : null,
    };
  });

  // Owner-only: system metrics, busiest webchat rooms, container runtime probe,
  // ollama probe.
  if (!ownerCaller) {
    return {
      restricted: true,
      health: { uptime: process.uptime(), container_runtime_ok: false },
      agents: { total: allAgents.length, visible: visibleAgents.length },
      sessions: { active: sessionsActive, total: sessionsTotal },
      messages: { webchat_24h: messages24h },
      channels,
      system: null,
      ollama: null,
      recent_agents: recentAgents,
      busiest_rooms: null,
      active_containers: null,
    };
  }

  // Busiest webchat rooms (24h) — top 5 by message count.
  const busiestRows = db
    .prepare(
      `SELECT m.room_id AS id, mg.name AS name, COUNT(*) AS count
       FROM webchat_messages m
       LEFT JOIN messaging_groups mg
         ON mg.channel_type = 'webchat' AND mg.platform_id = m.room_id
       WHERE m.created_at > ?
       GROUP BY m.room_id
       ORDER BY count DESC
       LIMIT 5`,
    )
    .all(yesterdayMs) as { id: string; name: string | null; count: number }[];
  const busiestRooms = busiestRows.map((r) => ({ id: r.id, name: r.name ?? r.id, count: r.count }));

  // System.
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const system = {
    memory_used_pct: Math.round(((totalMem - freeMem) / totalMem) * 100),
    memory_used_gb: +((totalMem - freeMem) / 1073741824).toFixed(1),
    memory_total_gb: +(totalMem / 1073741824).toFixed(1),
    load_avg: os.loadavg().map((v) => +v.toFixed(2)),
    cpus: os.cpus().length,
    platform: os.platform(),
  };

  // Active containers — `docker ps --filter name=nanoclaw-`. Best-effort.
  const activeContainers = await countNanoClawContainers();

  // Ollama — probe only if env-configured. Mirrors v1.
  const ollama = await probeOllama();

  return {
    restricted: false,
    health: { uptime: process.uptime(), container_runtime_ok: activeContainers !== null },
    agents: { total: allAgents.length, visible: visibleAgents.length },
    sessions: { active: sessionsActive, total: sessionsTotal },
    messages: { webchat_24h: messages24h },
    channels,
    system,
    ollama,
    recent_agents: recentAgents,
    busiest_rooms: busiestRooms,
    active_containers: activeContainers,
  };
}

async function countNanoClawContainers(): Promise<number | null> {
  try {
    const out = await new Promise<string>((resolve, reject) =>
      execFile(
        'docker',
        ['ps', '--filter', 'name=nanoclaw-', '--format', '{{.Names}}'],
        { timeout: 3000 },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      ),
    );
    return out.trim().split('\n').filter(Boolean).length;
  } catch {
    return null;
  }
}

async function probeOllama(): Promise<{ ok: boolean; host: string; models?: string[] } | null> {
  const host = process.env.OLLAMA_HOST || '';
  if (!host) return null;
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false, host };
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return { ok: true, host, models: (data.models ?? []).map((m) => m.name) };
  } catch {
    return { ok: false, host };
  }
}

/**
 * Provision an agent + its webchat room together. Used by both POST /api/agents
 * (agent-first) and POST /api/rooms (room-first) so they end up in the same
 * shape regardless of which entry point the caller used.
 */
function provisionWebchatAgentWithRoom(
  name: string,
  opts: { folder?: string; instructions?: string } = {},
): { group: AgentGroup } | { error: string; status: number } {
  const folder = opts.folder && /^[a-z0-9_-]+$/i.test(opts.folder) ? opts.folder : nameToFolder(name);
  if (!folder) return { error: 'Could not derive folder from name', status: 400 };
  const group: AgentGroup = {
    id: newAgentGroupId(),
    name,
    folder,
    agent_provider: null,
    created_at: new Date().toISOString(),
    status: 'active',
  };

  // The three steps (DB row, on-disk folder, wiring) need to land together
  // or roll back together. Without the transaction, an exception in
  // initGroupFilesystem / wireAgentToWebchatRoom leaves an orphan agent_group
  // row + (possibly) a half-initialized folder, and the next retry hits a
  // UNIQUE-violation on agent_groups.folder for a row the operator didn't
  // intend to keep.
  const groupDir = path.resolve(GROUPS_DIR, folder);
  const dirExisted = fs.existsSync(groupDir);
  try {
    getDb().transaction(() => {
      createAgentGroup(group);
      initGroupFilesystem(group, { instructions: opts.instructions });
      wireAgentToWebchatRoom(name, folder, group.id);
      // Auto-prime the agent on its own 1:1 room. With a single wired
      // agent the prime designation is a no-op for routing (engage_pattern
      // stays '.'), but pre-priming means that when the operator wires a
      // second agent later, the original keeps responding by default —
      // matching the user-visible expectation "the first agent answers
      // until I say otherwise."
      setPrimeAgentForWebchatRoom(folder, group.id);
    })();
  } catch (err) {
    // SQLite error messages can leak schema details ("UNIQUE constraint
    // failed: agent_groups.folder"). Return a stable string and log the
    // detail for the operator.
    log.warn('Webchat: provisionWebchatAgentWithRoom failed', { folder, err });
    // Roll back the on-disk side ourselves — the DB transaction already
    // rolled back its rows, but initGroupFilesystem may have created the
    // directory before the failing step.
    if (!dirExisted) {
      try {
        fs.rmSync(groupDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    const conflict =
      err instanceof Error && /UNIQUE|already exists/i.test(err.message)
        ? { error: 'Agent group already exists', status: 409 as const }
        : { error: 'Could not create agent group', status: 500 as const };
    return conflict;
  }
  return { group };
}

/**
 * Agent list shape returned to the PWA. Adds `room_id` (the wired webchat
 * room id, if any) so the PWA can map agents to rooms without baking in v1's
 * `chat:<folder>` jid convention.
 */
interface AgentForUI extends AgentGroup {
  room_id: string | null;
  assigned_model_id: string | null;
}

function toAgentForUI(g: AgentGroup): AgentForUI {
  // Convention: createAgentHandler uses `group.folder` as the webchat_room id when it
  // creates a room alongside the agent. Look that up directly so the PWA
  // doesn't have to guess.
  const room = getWebchatRoom(g.folder);
  const assigned = getAssignedModelForAgent(g.id);
  return { ...g, room_id: room ? room.id : null, assigned_model_id: assigned ? assigned.id : null };
}

function resolveAgent(idOrJid: string): AgentGroup | null {
  return getAgentGroup(idOrJid) ?? null;
}

function listAgentsForUser(userId: string, includeArchived = false): AgentForUI[] {
  const all = getAllAgentGroups();
  const role = isOwner(userId) ? all : all.filter((g) => hasAdminPrivilege(userId, g.id));
  // Archived agents are hidden by default — this declutters every consumer
  // (agent list, pickers, topology/matrix) at once. The agent list opts in via
  // ?includeArchived=1 so they can still be managed (unarchived).
  const visible = includeArchived ? role : role.filter((g) => g.status !== 'archived');
  return visible.map(toAgentForUI);
}

// ── Permissions admin (owner-only) ─────────────────────────────────────
//
// Denormalized "all users + their privilege state" view used by the PWA
// Permissions section. Each role / membership carries its audit pair
// (granted_by + granted_at, or added_by + added_at) so the PWA can show
// per-cell tooltips without a second round-trip.
interface RoleEntry {
  kind: 'owner' | 'admin';
  agent_group_id: string | null;
  granted_by: string | null;
  granted_at: string;
}

interface MembershipEntry {
  agent_group_id: string;
  added_by: string | null;
  added_at: string;
}

interface UserWithPermissions {
  id: string;
  kind: string;
  display_name: string | null;
  roles: RoleEntry[];
  memberships: MembershipEntry[];
}

export function listUsersWithPermissions(callerUserId?: string): UserWithPermissions[] {
  const users = permsGetAllUsers();
  const groups = getAllAgentGroups();
  // Scoping: owners and global admins get the full cross-group matrix. A
  // scoped admin only sees role/membership assignments within the groups they
  // administer — never the global owner/admin roster or other groups' members.
  // The user *list* itself is unfiltered (an admin must be able to add any
  // user as a member of their group), but the per-user roles/memberships are
  // restricted to the caller's administered groups.
  const fullView = !callerUserId || isOwner(callerUserId) || isGlobalAdmin(callerUserId);
  const scopedGroupIds = fullView
    ? null
    : new Set(groups.filter((g) => hasAdminPrivilege(callerUserId, g.id)).map((g) => g.id));
  const visibleGroups = scopedGroupIds ? groups.filter((g) => scopedGroupIds.has(g.id)) : groups;
  // Pre-fetch members once per group, keep the full audit-rich rows so we
  // can surface added_by / added_at to the UI.
  const membersByGroup = new Map(visibleGroups.map((g) => [g.id, permsGetMembers(g.id)]));

  return users.map((u) => {
    const roles: RoleEntry[] = permsGetUserRoles(u.id)
      .filter((r) => fullView || (r.agent_group_id !== null && scopedGroupIds!.has(r.agent_group_id)))
      .map((r) => ({
        kind: r.role,
        agent_group_id: r.agent_group_id,
        granted_by: r.granted_by,
        granted_at: r.granted_at,
      }));
    const memberships: MembershipEntry[] = [];
    for (const [groupId, members] of membersByGroup) {
      const m = members.find((x) => x.user_id === u.id);
      if (m) {
        memberships.push({
          agent_group_id: groupId,
          added_by: m.added_by,
          added_at: m.added_at,
        });
      }
    }
    return {
      id: u.id,
      kind: u.kind,
      display_name: u.display_name ?? null,
      roles,
      memberships,
    };
  });
}

/**
 * Derive the `users.kind` field from a namespaced user_id like
 * `webchat:tailscale:foo@bar.com`. Used when the owner adds a user who
 * hasn't authenticated yet — we pre-create the row so future grants/queries
 * resolve. Falls back to 'unknown' for ids without a recognised prefix
 * rather than failing the grant entirely; the grant still works because
 * everything keys on `user_id`, kind is just metadata for display.
 */
function deriveUserKind(userId: string): string {
  const colon = userId.indexOf(':');
  if (colon < 0) return 'unknown';
  return userId.slice(0, colon);
}

interface GrantBody {
  userId?: unknown;
  kind?: unknown;
  agentGroupId?: unknown;
}

function validateGrantBody(
  body: GrantBody,
): { error: string } | { userId: string; kind: 'owner' | 'admin' | 'member'; agentGroupId: string | null } {
  const rawUserId = typeof body.userId === 'string' ? body.userId.trim() : '';
  if (!rawUserId) return { error: 'userId required' };
  if (!rawUserId.includes(':')) return { error: 'userId must be namespaced (e.g. webchat:tailscale:foo@bar.com)' };
  // Fold webchat ids to the canonical form the auth layer mints at login, so a
  // grant matches the eventual session regardless of casing / typed prefix.
  const targetUserId = canonicalizeWebchatUserId(rawUserId);
  const kind = body.kind;
  if (kind !== 'owner' && kind !== 'admin' && kind !== 'member') {
    return { error: 'kind must be one of: owner, admin, member' };
  }
  const agentGroupId =
    body.agentGroupId === null || body.agentGroupId === undefined
      ? null
      : typeof body.agentGroupId === 'string'
        ? body.agentGroupId
        : null;
  if (kind === 'owner' && agentGroupId !== null) {
    return { error: 'owner role is always global; agentGroupId must be null' };
  }
  if (kind === 'member' && agentGroupId === null) {
    return { error: 'member role requires agentGroupId' };
  }
  if (agentGroupId && !getAgentGroup(agentGroupId)) {
    return { error: `agentGroupId ${agentGroupId} does not exist` };
  }
  return { userId: targetUserId, kind, agentGroupId };
}

/**
 * Authorization guard shared by /api/permissions/grant and /revoke.
 *
 * Owners can grant/revoke anything. Everyone else (scoped or global admins)
 * may only touch **member** access, and only on a group they have admin
 * privilege over — `admin`/`owner` grants stay owner-only because they
 * escalate privilege, and cross-group member changes are rejected.
 *
 * Returns `null` when the caller is authorized, otherwise the 403 body to
 * send. This is the privilege boundary for delegated member management;
 * keep it pure and unit-tested (member-grant-auth.test.ts).
 */
export function checkMemberGrantAuth(
  callerUserId: string,
  kind: unknown,
  agentGroupId: unknown,
): { error: string } | null {
  if (isOwner(callerUserId)) return null;
  if (kind !== 'member') return { error: 'Owner only' };
  const groupId = typeof agentGroupId === 'string' ? agentGroupId : null;
  if (!groupId || !hasAdminPrivilege(callerUserId, groupId)) {
    return { error: 'Admin privilege required for this group' };
  }
  return null;
}

function grantPermissionHandler(res: ServerResponse, body: GrantBody, callerUserId: string): void {
  const parsed = validateGrantBody(body);
  if ('error' in parsed) return json(res, 400, { error: parsed.error });
  const { userId: targetUserId, kind, agentGroupId } = parsed;

  // Upsert the users row so grants on never-seen-before identities work.
  // The kind is derived from the namespace; the display_name is left null
  // and gets populated by the channel adapter on first auth.
  if (!permsGetUser(targetUserId)) {
    permsUpsertUser({
      id: targetUserId,
      kind: deriveUserKind(targetUserId),
      display_name: null,
      created_at: new Date().toISOString(),
    });
  }

  const now = new Date().toISOString();
  if (kind === 'member') {
    permsAddMember({
      user_id: targetUserId,
      agent_group_id: agentGroupId as string,
      added_by: callerUserId,
      added_at: now,
    });
    log.info('Webchat: granted member', { targetUserId, agentGroupId, by: callerUserId });
  } else {
    permsGrantRole({
      user_id: targetUserId,
      role: kind,
      agent_group_id: agentGroupId,
      granted_by: callerUserId,
      granted_at: now,
    });
    log.info('Webchat: granted role', { targetUserId, role: kind, agentGroupId, by: callerUserId });
  }
  return json(res, 200, { ok: true });
}

/**
 * Refuse to delete a user that still has any roles or memberships — forces
 * the operator to revoke explicitly first, which keeps the audit trail
 * honest. Also refuses to delete the caller themselves (you can't sit on
 * the branch you're sawing).
 */
function deleteUserHandler(res: ServerResponse, targetUserId: string, callerUserId: string): void {
  if (!targetUserId) return json(res, 400, { error: 'userId required' });
  if (targetUserId === callerUserId) {
    return json(res, 409, { error: 'Cannot delete yourself' });
  }
  const target = permsGetUser(targetUserId);
  if (!target) return json(res, 404, { error: 'User not found' });
  const roles = permsGetUserRoles(targetUserId);
  if (roles.length > 0) {
    return json(res, 409, {
      error: 'User still has roles — revoke them first',
      remaining_roles: roles.length,
    });
  }
  // Iterate agent_groups to find lingering member rows — there's no
  // direct "memberships for user" helper today, so reuse the listing path.
  for (const g of getAllAgentGroups()) {
    if (permsGetMembers(g.id).some((m) => m.user_id === targetUserId)) {
      return json(res, 409, { error: 'User still has memberships — revoke them first' });
    }
  }
  // Clean up user_dms cache rows before deleting — user_dms.user_id has a
  // FK reference to users(id) that would otherwise block the delete.
  getDb().prepare('DELETE FROM user_dms WHERE user_id = ?').run(targetUserId);
  permsDeleteUser(targetUserId);
  log.info('Webchat: deleted user', { targetUserId, by: callerUserId });
  return json(res, 200, { ok: true });
}

function revokePermissionHandler(res: ServerResponse, body: GrantBody): void {
  const parsed = validateGrantBody(body);
  if ('error' in parsed) return json(res, 400, { error: parsed.error });
  const { userId: targetUserId, kind, agentGroupId } = parsed;

  // Last-owner protection: revoking the only owner would brick the system
  // (no one could grant roles back). Refuse.
  if (kind === 'owner') {
    const owners = permsGetOwners();
    const stillOwner = owners.filter((o) => o.user_id !== targetUserId);
    if (stillOwner.length === 0) {
      return json(res, 409, { error: 'Cannot revoke the last owner' });
    }
  }

  if (kind === 'member') {
    permsRemoveMember(targetUserId, agentGroupId as string);
    log.info('Webchat: revoked member', { targetUserId, agentGroupId });
  } else {
    permsRevokeRole(targetUserId, kind, agentGroupId);
    log.info('Webchat: revoked role', { targetUserId, role: kind, agentGroupId });
  }
  return json(res, 200, { ok: true });
}

async function createAgentHandler(req: IncomingMessage, res: ServerResponse, creatorUserId: string): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: {
    name?: unknown;
    folder?: unknown;
    instructions?: unknown;
    withRoom?: unknown;
    roomName?: unknown;
  };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (typeof body.name !== 'string' || !body.name.trim()) {
    return json(res, 400, { error: 'name required' });
  }
  const name = body.name.trim();

  // `withRoom` defaults to false: agents are entities, rooms are conversation
  // spaces. Creating an agent does not implicitly publish it to a chat
  // surface — wire it into a room afterwards (`POST /api/rooms` or the
  // PWA's "+ Add agent" inside an existing room). Pass `withRoom: true`
  // explicitly to opt into the legacy 1:1 agent-and-room provisioning.
  if (body.withRoom !== true) {
    const result = createBareAgentGroup(name, {
      folder: typeof body.folder === 'string' ? body.folder : undefined,
      instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
    });
    if ('error' in result) return json(res, result.status, { error: result.error });
    grantCreatorAdmin(creatorUserId, result.group.id);
    return json(res, 200, { ok: true, agentGroup: result.group, roomId: null });
  }

  const roomName = typeof body.roomName === 'string' && body.roomName.trim() ? body.roomName.trim() : name;
  const provisioned = provisionWebchatAgentWithRoom(roomName, {
    folder: typeof body.folder === 'string' ? body.folder : undefined,
    instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
  });
  if ('error' in provisioned) return json(res, provisioned.status, { error: provisioned.error });
  grantCreatorAdmin(creatorUserId, provisioned.group.id);
  broadcastRooms();
  return json(res, 200, {
    ok: true,
    agentGroup: provisioned.group,
    roomId: provisioned.group.folder,
  });
}

/**
 * Auto-grant the creator scoped admin on the agent they just created.
 *
 * Agent creation is gated on `isAnyAdmin` (owner, global admin, or scoped
 * admin of *some* group). A scoped admin creating a new agent would otherwise
 * immediately lose access to it — `listAgentsForUser` and the per-agent admin
 * checks filter to owner / `hasAdminPrivilege(group)`, and the new group isn't
 * one they administer. Granting them scoped admin on the new group closes
 * that gap so "you can create it" implies "you can manage it".
 *
 * Skipped for owners and global admins — they already have authority over
 * every group, so a scoped row would be redundant noise in `user_roles`.
 * No-op if the permissions module isn't installed.
 */
function grantCreatorAdmin(creatorUserId: string, agentGroupId: string): void {
  if (isOwner(creatorUserId) || isGlobalAdmin(creatorUserId)) return;
  try {
    permsGrantRole({
      user_id: creatorUserId,
      role: 'admin',
      agent_group_id: agentGroupId,
      granted_by: creatorUserId,
      granted_at: new Date().toISOString(),
    });
  } catch (err) {
    log.warn('Failed to auto-grant creator admin on new agent', {
      creatorUserId,
      agentGroupId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

async function updateAgentHandler(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const existing = getAgentGroup(id);
  if (!existing) return json(res, 404, { error: 'Agent not found' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { name?: unknown; agent_provider?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const updates: { name?: string; agent_provider?: string | null } = {};
  if (typeof body.name === 'string' && body.name.trim()) updates.name = body.name.trim();
  if (typeof body.agent_provider === 'string') updates.agent_provider = body.agent_provider;
  if (body.agent_provider === null) updates.agent_provider = null;
  updateAgentGroup(id, updates);
  return json(res, 200, { ok: true });
}

async function draftAgentHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { prompt?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (typeof body.prompt !== 'string') {
    return json(res, 400, { error: 'prompt required' });
  }
  try {
    const drafted = await draftAgent(body.prompt);
    return json(res, 200, { ok: true, ...drafted });
  } catch (err) {
    if (err instanceof DraftError) return json(res, err.status, { error: err.message });
    log.warn('Webchat: draftAgentHandler failed', { err });
    return json(res, 500, { error: 'Drafter failed' });
  }
}

function deleteAgentHandler(res: ServerResponse, id: string): void {
  const group = getAgentGroup(id);
  if (!group) return json(res, 404, { error: 'Agent not found' });

  // Snapshot every session this agent owns — home-room and any other rooms
  // it's wired to. All of them FK to `agent_groups.id`, so all must be torn
  // down before deleteAgentGroup. Captured before the tx so post-commit
  // resource cleanup can find them.
  const sessions = findSessionsByAgentGroup(id);

  try {
    getDb().transaction(() => {
      const db = getDb();
      for (const s of sessions) deleteSessionDbState(s.sessionId);
      db.prepare(`DELETE FROM messaging_group_agents WHERE agent_group_id = ?`).run(id);
      // Drop the model assignment too — the agent is going away, no point
      // keeping a row pointing at a dead agent_group_id.
      unassignModelFromAgent(id);
      // Drop agent_destinations rows owned by this agent — the FK
      // (agent_destinations.agent_group_id REFERENCES agent_groups.id) would
      // otherwise block deleteAgentGroup. Guarded — a2a module may not be
      // installed, in which case the table is absent.
      if (hasTable(db, 'agent_destinations')) {
        db.prepare(`DELETE FROM agent_destinations WHERE agent_group_id = ?`).run(id);
      }
      // Delete the home room (its own session rows are already gone above).
      deleteWebchatRoom(group.folder);
      deleteAgentGroup(id);
    })();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Webchat: deleteAgentHandler failed', { id, err });
    return json(res, 500, { error: 'Failed to delete agent', message });
  }

  void teardownSessionResources(sessions, `webchat agent ${id} deleted`);

  const dir = path.resolve(GROUPS_DIR, group.folder);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    log.warn('Webchat: failed to remove group folder', { folder: group.folder, err });
  }

  broadcastRooms();
  return json(res, 200, { ok: true });
}

function readInstructions(res: ServerResponse, id: string): void {
  const group = getAgentGroup(id);
  if (!group) return json(res, 404, { error: 'Agent not found' });
  const file = path.resolve(GROUPS_DIR, group.folder, 'CLAUDE.local.md');
  const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  return json(res, 200, { content });
}

async function writeInstructions(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const group = getAgentGroup(id);
  if (!group) return json(res, 404, { error: 'Agent not found' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { content?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const dir = path.resolve(GROUPS_DIR, group.folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'CLAUDE.local.md'), typeof body.content === 'string' ? body.content : '');
  return json(res, 200, { ok: true });
}

// ── Room handlers ──

/**
 * Refs to agents in the room create / add-agent endpoints. Either an existing
 * agent (by id) or a new agent created inline.
 */
type AgentRef = { kind: 'existing'; id: string } | { kind: 'new'; name: string; instructions?: string };

function parseAgentRef(raw: unknown): AgentRef | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'Invalid agent reference' };
  const r = raw as { kind?: unknown; id?: unknown; name?: unknown; instructions?: unknown };
  if (r.kind === 'existing') {
    if (typeof r.id !== 'string' || !r.id.trim()) return { error: 'agent.id required for kind=existing' };
    return { kind: 'existing', id: r.id.trim() };
  }
  if (r.kind === 'new') {
    if (typeof r.name !== 'string' || !r.name.trim()) return { error: 'agent.name required for kind=new' };
    return {
      kind: 'new',
      name: r.name.trim(),
      instructions: typeof r.instructions === 'string' ? r.instructions : undefined,
    };
  }
  return { error: 'agent.kind must be "existing" or "new"' };
}

/**
 * Create a bare agent_group + on-disk filesystem. No room is created and no
 * wiring happens. Used by both POST /api/agents `withRoom: false` and the
 * room-first POST /api/rooms "create new agent inline" path.
 */
function createBareAgentGroup(
  name: string,
  opts: { folder?: string; instructions?: string } = {},
): { group: AgentGroup } | { error: string; status: number } {
  const folder = opts.folder && /^[a-z0-9_-]+$/i.test(opts.folder) ? opts.folder : nameToFolder(name);
  if (!folder) return { error: 'Could not derive folder from name', status: 400 };
  const group: AgentGroup = {
    id: newAgentGroupId(),
    name,
    folder,
    agent_provider: null,
    created_at: new Date().toISOString(),
    status: 'active',
  };
  try {
    createAgentGroup(group);
  } catch (err) {
    return { error: `Could not create agent group: ${(err as Error).message}`, status: 409 };
  }
  initGroupFilesystem(group, { instructions: opts.instructions });
  return { group };
}

async function createRoomHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { name?: unknown; agents?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (typeof body.name !== 'string' || !body.name.trim()) return json(res, 400, { error: 'name required' });
  const roomName = body.name.trim();
  if (!Array.isArray(body.agents) || body.agents.length === 0) {
    return json(res, 400, { error: 'At least one agent required (rooms cannot be empty)' });
  }

  // Validate everything up-front so we don't half-create.
  const refs: AgentRef[] = [];
  for (const ref of body.agents) {
    const p = parseAgentRef(ref);
    if ('error' in p) return json(res, 400, { error: p.error });
    if (p.kind === 'existing' && !getAgentGroup(p.id)) {
      return json(res, 404, { error: `Agent ${p.id} not found` });
    }
    refs.push(p);
  }

  const roomId = nameToFolder(roomName);
  if (!roomId) return json(res, 400, { error: 'Could not derive room id from name' });
  if (getMessagingGroupByPlatform('webchat', roomId)) {
    return json(res, 409, { error: 'Room with this name already exists' });
  }

  // Create any "new" agents first (they live outside the DB transaction
  // because initGroupFilesystem touches disk). Track them so we can roll
  // back if the wiring step fails.
  const createdAgentIds: string[] = [];
  const wireIds: string[] = [];
  for (const ref of refs) {
    if (ref.kind === 'existing') {
      wireIds.push(ref.id);
      continue;
    }
    const result = createBareAgentGroup(ref.name, { instructions: ref.instructions });
    if ('error' in result) {
      rollbackBareAgents(createdAgentIds);
      return json(res, result.status, { error: result.error });
    }
    createdAgentIds.push(result.group.id);
    wireIds.push(result.group.id);
  }

  try {
    getDb().transaction(() => {
      createWebchatRoom(roomName, roomId);
      for (const id of wireIds) wireAgentToWebchatRoom(roomName, roomId, id);
      // Default engage mode is mention-only: agents fire on explicit @-mention.
      // EXCEPTION: a room created with exactly one agent auto-primes that agent
      // (it then replies to everything) — consistent with the empty-room →
      // first-agent path below, and avoiding the "you must @-mention the only
      // agent to get a reply" surprise. Multi-agent rooms stay mention-only
      // until the operator picks a default. Inside the transaction so a partial
      // failure can't leave a settings/prime row referencing a half-created room.
      setRoomEngageDefault(roomId, 'mention-only');
      if (wireIds.length === 1) setPrimeAgentForWebchatRoom(roomId, wireIds[0]);
    })();
    // recomputeEngagePatterns reads the current wirings + prime + engage_default,
    // so it runs AFTER the transaction commits: a single-agent room now has a
    // prime (→ that agent answers everything); a multi-agent room has none
    // (→ every wiring gets `\B@<folder>\b`).
    recomputeEngagePatterns(roomId);
  } catch (err) {
    rollbackBareAgents(createdAgentIds);
    log.warn('Webchat: createRoom failed', { roomName, err });
    return json(res, 500, { error: 'Could not create room' });
  }

  broadcastRooms();
  return json(res, 200, {
    ok: true,
    room: getWebchatRoom(roomId),
    agents: getAgentsForWebchatRoom(roomId),
  });
}

function rollbackBareAgents(ids: string[]): void {
  for (const id of ids) {
    try {
      const g = getAgentGroup(id);
      deleteAgentGroup(id);
      if (g) {
        const dir = path.resolve(GROUPS_DIR, g.folder);
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
    } catch {
      // best-effort — log? these are inner-loop rollbacks
    }
  }
}

function deleteRoomHandler(res: ServerResponse, roomId: string): void {
  const room = getWebchatRoom(roomId);
  if (!room) return json(res, 404, { error: 'Room not found' });

  const mg = getMessagingGroupByPlatform('webchat', roomId);
  // Snapshot sessions before the transaction so we can clean up containers
  // and dirs after it commits (side-effects can't roll back).
  const sessions: TeardownTarget[] = mg ? findSessionsByMessagingGroup(mg.id) : [];

  try {
    getDb().transaction(() => {
      for (const s of sessions) deleteSessionDbState(s.sessionId);
      // deleteWebchatRoom drops messages, wirings, and the messaging_group row.
      // Agents are deliberately preserved — they may be wired to other rooms,
      // and DELETE /api/agents/:id is the cascade-to-agent path.
      deleteWebchatRoom(roomId);
    })();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Webchat: deleteRoomHandler failed', { roomId, err });
    return json(res, 500, { error: 'Failed to delete room', message });
  }

  // Fire-and-forget: the DB tx committed, so we can respond immediately.
  // Container kills + dir cleanup are best-effort post-commit hygiene that
  // the user doesn't need to wait on. Errors are logged inside the helper.
  void teardownSessionResources(sessions, `webchat room ${roomId} deleted`);

  // Remove the room's upload dir. The messaging_group is gone, so the files
  // are unreachable from the API — leaving them is just dead disk space.
  const uploadsDir = path.resolve(DATA_DIR, 'webchat', 'uploads', roomId);
  try {
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  } catch (err) {
    log.warn('Webchat: failed to remove room uploads dir', { roomId, err });
  }

  broadcastRooms();
  return json(res, 200, { ok: true });
}

async function addAgentToRoomHandler(
  req: IncomingMessage,
  res: ServerResponse,
  roomId: string,
  userId: string,
): Promise<void> {
  const room = getWebchatRoom(roomId);
  if (!room) return json(res, 404, { error: 'Room not found' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let parsed: AgentRef | { error: string };
  try {
    parsed = parseAgentRef(JSON.parse(raw));
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if ('error' in parsed) return json(res, 400, { error: parsed.error });

  let agentId: string;
  let createdAgentId: string | null = null;
  if (parsed.kind === 'existing') {
    if (!getAgentGroup(parsed.id)) return json(res, 404, { error: `Agent ${parsed.id} not found` });
    // Owner can wire any agent. A scoped admin may wire an agent THEY
    // administer to a room they can access (the same access set the picker
    // is filtered to).
    if (!isOwner(userId) && !(canAccessRoom(userId, roomId) && hasAdminPrivilege(userId, parsed.id))) {
      return json(res, 403, { error: 'Admin privilege required' });
    }
    agentId = parsed.id;
  } else {
    // Creating a brand-new agent via this path stays owner-only: unlike
    // createAgentHandler, this branch does not grant the creator admin on the
    // new group, so a scoped admin would end up unable to manage what they
    // just made. Scoped admins assign EXISTING agents (the branch above).
    if (!isOwner(userId)) {
      return json(res, 403, { error: 'Owner only' });
    }
    const result = createBareAgentGroup(parsed.name, { instructions: parsed.instructions });
    if ('error' in result) return json(res, result.status, { error: result.error });
    agentId = result.group.id;
    createdAgentId = result.group.id;
  }

  // Snapshot the count BEFORE wiring so we can decide whether the new
  // agent should auto-become prime. Rule: a room transitioning from
  // 0 → 1 wired agents (e.g. an empty room being seeded, or an agent
  // re-added after the prior one was unwired) auto-primes the newcomer.
  // Rooms going from 1+ → 2+ leave the existing prime alone — operator
  // picks via the ★ toggle if they want to swap.
  const wasEmpty = countAgentsForWebchatRoom(roomId) === 0;

  try {
    wireAgentToWebchatRoom(room.name, roomId, agentId);
    if (wasEmpty) {
      setPrimeAgentForWebchatRoom(roomId, agentId);
      recomputeEngagePatterns(roomId);
    }
  } catch (err) {
    if (createdAgentId) rollbackBareAgents([createdAgentId]);
    log.warn('Webchat: addAgentToRoom failed', { roomId, agentId, err });
    return json(res, 500, { error: 'Could not wire agent to room' });
  }

  broadcastRooms();
  const wired: WebchatRoomAgent | undefined = getAgentsForWebchatRoom(roomId).find((a) => a.id === agentId);
  return json(res, 200, { ok: true, agent: wired });
}

function removeAgentFromRoomHandler(res: ServerResponse, roomId: string, agentId: string): void {
  const room = getWebchatRoom(roomId);
  if (!room) return json(res, 404, { error: 'Room not found' });
  if (countAgentsForWebchatRoom(roomId) <= 1) {
    return json(res, 400, {
      error: 'Cannot remove the last agent from a room. Delete the room with DELETE /api/rooms/:id instead.',
    });
  }
  const removed = unwireAgentFromWebchatRoom(roomId, agentId);
  if (!removed) return json(res, 404, { error: 'Agent is not wired to this room' });
  // If we just unwired the prime, clear the designation. Recompute either
  // way so remaining wirings get a fresh pattern set (the prime's
  // negative-lookahead may need to lose this agent's folder, or the
  // patterns may need to revert to '.').
  if (getPrimeAgentForWebchatRoom(roomId) === agentId) {
    clearPrimeAgentForWebchatRoom(roomId);
  }
  recomputeEngagePatterns(roomId);
  broadcastRooms();
  return json(res, 200, { ok: true });
}

function setRoomPrimeHandler(res: ServerResponse, roomId: string, agentId: string): void {
  const room = getWebchatRoom(roomId);
  if (!room) return json(res, 404, { error: 'Room not found' });
  // Verify the candidate is actually wired to this room — otherwise the
  // recompute would treat the prime as stale and silently fall back.
  const wired = getAgentsForWebchatRoom(roomId).some((a) => a.id === agentId);
  if (!wired) return json(res, 400, { error: 'Agent is not wired to this room' });
  setPrimeAgentForWebchatRoom(roomId, agentId);
  recomputeEngagePatterns(roomId);
  broadcastRooms();
  return json(res, 200, { ok: true, primeAgentId: agentId });
}

function clearRoomPrimeHandler(res: ServerResponse, roomId: string): void {
  const room = getWebchatRoom(roomId);
  if (!room) return json(res, 404, { error: 'Room not found' });
  clearPrimeAgentForWebchatRoom(roomId);
  recomputeEngagePatterns(roomId);
  broadcastRooms();
  return json(res, 200, { ok: true });
}

// ── Models ──
//
// CRUD for webchat_models + per-agent model assignment. The "discover"
// endpoint is the cheap UX win — it lets the PWA populate the model_id
// dropdown from a live Ollama endpoint instead of asking the user to
// paste tag names.

interface ModelForUI extends WebchatModel {
  agents_assigned: number;
}

function listModelsForUI(): ModelForUI[] {
  return listWebchatModels().map((m) => ({ ...m, agents_assigned: getAgentsAssignedToModel(m.id).length }));
}

async function createModelHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { name?: unknown; kind?: unknown; endpoint?: unknown; model_id?: unknown; credential_ref?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (typeof body.name !== 'string' || !body.name.trim()) return json(res, 400, { error: 'name required' });
  if (body.kind !== 'anthropic' && body.kind !== 'ollama' && body.kind !== 'openai-compatible') {
    return json(res, 400, { error: 'kind must be "anthropic" | "ollama" | "openai-compatible"' });
  }
  if (typeof body.model_id !== 'string' || !body.model_id.trim()) {
    return json(res, 400, { error: 'model_id required' });
  }
  const endpoint =
    typeof body.endpoint === 'string' && body.endpoint.trim() ? body.endpoint.trim().replace(/\/+$/, '') : null;
  const credential_ref = typeof body.credential_ref === 'string' ? body.credential_ref.trim() : null;

  // Health-check / validate before persisting (Q5 — yes, on save).
  const validationError = await validateModel({ kind: body.kind, endpoint, model_id: body.model_id.trim() });
  if (validationError) return json(res, 400, { error: validationError });

  const m: WebchatModel = {
    id: randomUUID(),
    name: body.name.trim(),
    kind: body.kind as WebchatModelKind,
    endpoint,
    model_id: body.model_id.trim(),
    credential_ref,
    created_at: Date.now(),
  };
  createWebchatModel(m);
  return json(res, 200, { ok: true, model: { ...m, agents_assigned: 0 } });
}

async function updateModelHandler(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const existing = getWebchatModel(id);
  if (!existing) return json(res, 404, { error: 'Model not found' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { name?: unknown; endpoint?: unknown; model_id?: unknown; credential_ref?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const patch: { name?: string; endpoint?: string | null; model_id?: string; credential_ref?: string | null } = {};
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
  if (body.endpoint === null) patch.endpoint = null;
  else if (typeof body.endpoint === 'string') patch.endpoint = body.endpoint.trim().replace(/\/+$/, '') || null;
  if (typeof body.model_id === 'string' && body.model_id.trim()) patch.model_id = body.model_id.trim();
  if (body.credential_ref === null) patch.credential_ref = null;
  else if (typeof body.credential_ref === 'string') patch.credential_ref = body.credential_ref.trim() || null;

  // Re-validate the merged state.
  const merged = { ...existing, ...patch };
  const validationError = await validateModel({
    kind: merged.kind,
    endpoint: merged.endpoint,
    model_id: merged.model_id,
  });
  if (validationError) return json(res, 400, { error: validationError });

  updateWebchatModel(id, patch);
  // Endpoint or model_id change → re-emit env and respawn for every agent that
  // uses it, so live containers pick up the edited endpoint/model immediately.
  for (const agentGroupId of getAgentsAssignedToModel(id)) {
    reloadAgentModelEnv(agentGroupId, 'Webchat model updated');
  }
  return json(res, 200, { ok: true });
}

function deleteModelHandler(res: ServerResponse, id: string, force: boolean): void {
  const existing = getWebchatModel(id);
  if (!existing) return json(res, 404, { error: 'Model not found' });
  const assigned = getAgentsAssignedToModel(id);
  if (assigned.length > 0 && !force) {
    // Cascade-with-confirmation per Q3: refuse without ?force=1, surface
    // the impact list so the PWA can prompt the operator.
    return json(res, 409, {
      error: 'Model is assigned to agents. Re-POST with ?force=1 to unassign and delete.',
      assigned_agent_group_ids: assigned,
    });
  }
  deleteWebchatModel(id);
  // Refresh settings.json for any newly-orphaned agents and respawn them so a
  // live container doesn't keep using the now-dead ollama env block (it would
  // otherwise fail against a deleted endpoint until it idled out).
  for (const agentGroupId of assigned) {
    reloadAgentModelEnv(agentGroupId, 'Webchat model deleted');
  }
  return json(res, 200, { ok: true, unassigned_count: assigned.length });
}

async function probeModelsHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { url?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (typeof body.url !== 'string' || !body.url.trim()) {
    return json(res, 400, { error: 'url required' });
  }
  // Accept bare hosts ("localhost:11434", "api.anthropic.com") as well as
  // http:// / https:// URLs. probeEndpoint races both schemes when no
  // scheme is supplied. Defensive: reject inputs that look like garbage
  // (whitespace inside, angle brackets) early so we don't waste a probe
  // round-trip on malformed input.
  const url = body.url.trim();
  if (/\s|[<>]/.test(url)) {
    return json(res, 400, { error: 'url contains invalid characters' });
  }
  try {
    const result = await probeEndpoint(url);
    return json(res, 200, result);
  } catch (err) {
    log.warn('Webchat: probe failed', { url, err });
    return json(res, 500, { error: err instanceof Error ? err.message : 'Probe failed' });
  }
}

async function bulkCreateModelsHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { models?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (!Array.isArray(body.models) || body.models.length === 0) {
    return json(res, 400, { error: 'models[] required' });
  }
  // Same validation per row as the single-create path. We accept a partial
  // success: rows that pass validate go in, failures come back per-index in
  // the response. The PWA can re-prompt for the failed ones.
  const created: WebchatModel[] = [];
  const failed: Array<{ index: number; error: string }> = [];
  for (let i = 0; i < body.models.length; i++) {
    const entry = body.models[i] as Record<string, unknown>;
    if (!entry || typeof entry !== 'object') {
      failed.push({ index: i, error: 'entry must be an object' });
      continue;
    }
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const kind = entry.kind;
    const model_id = typeof entry.model_id === 'string' ? entry.model_id.trim() : '';
    const endpoint =
      typeof entry.endpoint === 'string' && entry.endpoint.trim() ? entry.endpoint.trim().replace(/\/+$/, '') : null;
    const credential_ref = typeof entry.credential_ref === 'string' ? entry.credential_ref.trim() : null;

    if (!name) {
      failed.push({ index: i, error: 'name required' });
      continue;
    }
    if (kind !== 'anthropic' && kind !== 'ollama' && kind !== 'openai-compatible') {
      failed.push({ index: i, error: 'kind must be "anthropic" | "ollama" | "openai-compatible"' });
      continue;
    }
    if (!model_id) {
      failed.push({ index: i, error: 'model_id required' });
      continue;
    }
    const validationError = await validateModel({ kind, endpoint, model_id });
    if (validationError) {
      failed.push({ index: i, error: validationError });
      continue;
    }
    const m: WebchatModel = {
      id: randomUUID(),
      name,
      kind: kind as WebchatModelKind,
      endpoint,
      model_id,
      credential_ref,
      created_at: Date.now(),
    };
    try {
      createWebchatModel(m);
      created.push(m);
    } catch (err) {
      failed.push({ index: i, error: err instanceof Error ? err.message : 'create failed' });
    }
  }
  return json(res, 200, { ok: true, created_count: created.length, failed, created });
}

async function discoverModelsHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { kind?: unknown; endpoint?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (body.kind === 'anthropic') {
    return json(res, 200, { models: KNOWN_ANTHROPIC_MODELS });
  }
  if (body.kind === 'ollama') {
    if (typeof body.endpoint !== 'string' || !body.endpoint.trim()) {
      return json(res, 400, { error: 'endpoint required for kind=ollama' });
    }
    try {
      const models = await discoverOllamaModels(body.endpoint.trim());
      return json(res, 200, { models });
    } catch (err) {
      return json(res, 502, { error: err instanceof Error ? err.message : 'Ollama unreachable' });
    }
  }
  return json(res, 400, { error: 'kind must be "anthropic" or "ollama"' });
}

async function setAgentStatusHandler(req: IncomingMessage, res: ServerResponse, agentGroupId: string): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { status?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const status = body.status;
  if (status !== 'active' && status !== 'paused' && status !== 'archived') {
    return json(res, 400, { error: "status must be 'active', 'paused', or 'archived'" });
  }
  setAgentStatus(agentGroupId, status);
  const group = getAgentGroup(agentGroupId);
  return json(res, 200, group ? toAgentForUI(group) : { status });
}

async function assignAgentModelHandler(req: IncomingMessage, res: ServerResponse, agentGroupId: string): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { modelId?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  // null = unassign (back to default Anthropic credential + default model)
  if (body.modelId === null) {
    unassignModelFromAgent(agentGroupId);
  } else {
    if (typeof body.modelId !== 'string' || !body.modelId.trim()) {
      return json(res, 400, { error: 'modelId must be a string or null' });
    }
    if (!getWebchatModel(body.modelId.trim())) return json(res, 404, { error: 'Model not found' });
    assignModelToAgent(agentGroupId, body.modelId.trim());
  }
  reloadAgentModelEnv(agentGroupId, 'Webchat model reassigned');
  const current = getAssignedModelForAgent(agentGroupId);
  return json(res, 200, { ok: true, model: current });
}

/**
 * Re-materialize an agent group's model env into settings.json and force any
 * running container to respawn so the change actually takes effect.
 *
 * The model env (ANTHROPIC_MODEL / ANTHROPIC_BASE_URL) is read only at container
 * spawn, so without the restart a live container keeps serving the previous
 * model until it idles out — which the operator reads as "the switch didn't
 * take" (and surfaces as a wrong-model error). No wake message is written: we
 * don't want a spurious agent turn, just a clean env on the next real message.
 * restartAgentGroupContainers only respawns eagerly when there's already
 * pending work; otherwise it kills and waits for the next inbound. Each step is
 * isolated so a failure in one agent group doesn't abort the rest of the batch.
 */
function reloadAgentModelEnv(agentGroupId: string, reason: string): void {
  try {
    writeAgentSettingsForAssignedModel(agentGroupId);
  } catch (err) {
    log.warn('Webchat: settings.json write after model change failed', { agentGroupId, reason, err });
  }
  try {
    const restarted = restartAgentGroupContainers(agentGroupId, reason);
    if (restarted > 0) {
      log.info('Webchat: restarted containers after model change', { agentGroupId, reason, restarted });
    }
  } catch (err) {
    log.warn('Webchat: container restart after model change failed', { agentGroupId, reason, err });
  }
}

// ── Push subscriptions ──

async function pushSubscribe(req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  const db = getDb();
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
  const p256dh = typeof body.keys?.p256dh === 'string' ? body.keys.p256dh : '';
  const auth = typeof body.keys?.auth === 'string' ? body.keys.auth : '';
  if (!endpoint || !p256dh || !auth) return json(res, 400, { error: 'Missing endpoint or keys' });
  if (!isValidPushEndpoint(endpoint)) return json(res, 400, { error: 'Endpoint not on allowlist' });
  if (endpoint.length > 2048) return json(res, 400, { error: 'Endpoint too long' });
  if (p256dh.length > 256 || auth.length > 64) return json(res, 400, { error: 'Key material too long' });

  // Prevent identity-hijack on known endpoints.
  const existing = db.prepare(`SELECT identity FROM webchat_push_subscriptions WHERE endpoint = ?`).get(endpoint) as
    | { identity: string }
    | undefined;
  if (existing && existing.identity !== userId) {
    log.warn('Webchat push subscribe rejected — endpoint owned by different identity', {
      identity: userId,
      existingOwner: existing.identity,
      endpointTail: endpoint.slice(-24),
    });
    return json(res, 409, { error: 'Endpoint already registered to a different identity' });
  }
  db.prepare(
    `INSERT INTO webchat_push_subscriptions (endpoint, identity, keys_json, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET identity = excluded.identity, keys_json = excluded.keys_json`,
  ).run(endpoint, userId, JSON.stringify({ p256dh, auth }), Date.now());
  return json(res, 200, { ok: true });
}

async function pushUnsubscribe(req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { endpoint?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (typeof body.endpoint !== 'string') return json(res, 400, { error: 'Missing endpoint' });
  // Only allow deleting your own subscription.
  getDb()
    .prepare(`DELETE FROM webchat_push_subscriptions WHERE endpoint = ? AND identity = ?`)
    .run(body.endpoint, userId);
  return json(res, 200, { ok: true });
}

// Re-export for the adapter so it can flow files into webchat_messages too.
export { storeWebchatFileMessage };
export type { FileMeta };
