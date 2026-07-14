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
 *   GET  /api/rooms/:id/engage-mode              read room's engage default ('mention-only')
 *   PUT  /api/rooms/:id/engage-mode              set { mode } for the room  [owner]
 *   PUT  /api/rooms/:id/name                     rename the room (set { name })  [owner]
 *   GET  /api/rooms/:id/threads                  list threads (+ per-thread unread)
 *   POST /api/rooms/:id/threads                  create a topic thread ({ title })  [member]
 *   PATCH /api/rooms/:id/threads/:tid            rename a thread ({ title })  [member]
 *   DELETE /api/rooms/:id/threads/:tid           delete a thread + its session  [owner]
 *   PUT  /api/rooms/:id/threads/:tid/read        mark a thread read  [member]
 *   GET  /api/rooms/:id/messages                 history (?after_id= catch-up, ?before_id= scroll-back, ?thread_id=)
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
import zlib from 'node:zlib';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { readEnvFile } from '../../env.js';
import { getDb, hasTable } from '../../db/connection.js';
import { log } from '../../log.js';
import {
  deleteSessionDbState,
  findSessionsByAgentGroup,
  findSessionsByMessagingGroup,
  findSessionsByMessagingGroupThread,
  teardownSessionResources,
  type TeardownTarget,
} from '../../session-teardown.js';
import type { AgentGroup, MessagingGroup } from '../../types.js';
import type { EngagedDecision } from '../../router.js';
import {
  createAgentGroup,
  deleteAgentGroup,
  getAgentGroup,
  getAllAgentGroups,
  setAgentStatus,
  updateAgentGroup,
} from '../../db/agent-groups.js';
import { createMessagingGroupAgent, getMessagingGroup, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { syncSessionContext, type ContextMessage } from '../../session-manager.js';
import { getPendingApproval, getSession, getSessionsByAgentGroup } from '../../db/sessions.js';
import { insertMessage, openInboundDb } from '../../db/session-db.js';
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
import { projectDestinationsToActiveSessions } from '../../modules/agent-to-agent/write-destinations.js';
import type { InboundMessage, OutboundFile } from '../adapter.js';
import {
  assertBearerTokenStrength,
  authenticateRequest,
  canonicalizeWebchatUserId,
  getAuthInfo,
  getAuthManagementInfo,
  hasExplicitAuth,
  probeTailscaleHealth,
  requiresExplicitAuth,
  warnIfAutoProxyTrust,
} from './auth.js';
import { getTailscaleServeState, enableTailscaleServe } from './tailscale-serve.js';
import {
  getPullsSnapshot,
  getOllamaLocalState,
  startOllamaInstall,
  getRosterRefreshState,
  dryClassify,
  getRouteSuggestions,
  getRouterInfo,
  getRouterMetrics,
  listHostModels,
  mergeRoutesUpdate,
  primaryRouter,
  readRoutesConfig,
  recentDecisions,
  type RoutesUpdate,
  writeRoutesConfig,
  listRouters,
  routerView,
  addRouter,
  deleteRouter,
  parseConfiguredHosts,
  startPull,
  startRosterRefresh,
  getRoutingInstallState,
  startRoutingInstall,
} from './ollama-manage.js';
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
  getEffectiveModelForAgent,
  getPrimeAgentForWebchatRoom,
  getRoomEngageDefault,
  setRoomEngageDefault,
  isWebchatApprovalIndexedFor,
  getWebchatMessages,
  getWebchatMessagesAfterId,
  getWebchatMessagesBeforeId,
  searchWebchatMessages,
  ensureMainThread,
  listWebchatThreads,
  createWebchatThread,
  getWebchatThread,
  renameWebchatThread,
  deleteWebchatThread,
  MAIN_THREAD,
  threadToSessionKey,
  getThreadSyncMarks,
  setThreadSyncMark,
  getSyncDelta,
  insertSyncedMessages,
  engageAgent,
  disengageAgent,
  getEngagedAgents,
  getUnreadThreadIdsForRoom,
  markThreadRead,
  sanitizeThreadTitle,
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
  setPinnedOrderForUser,
  unassignModelFromAgent,
  unwireAgentFromWebchatRoom,
  updateWebchatModel,
  listSkillSources,
  upsertSkillSource,
  deleteSkillSource,
  isSourceDisabled,
  setSourceDisabled,
  type FileMeta,
  type WebchatModel,
  type WebchatModelKind,
  type WebchatRoomAgent,
  type WebchatSkillSource,
} from './db.js';
import { DraftError, draftAgent } from './drafter.js';
import { recommendForHost } from './model-recommend.js';
import {
  KNOWN_ANTHROPIC_MODELS,
  discoverOllamaModels,
  probeEndpoint,
  validateModel,
  writeAgentSettingsForAssignedModel,
  syncAgentProviderForAssignedModel,
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
  getOnboardingComplete,
  setOnboardingComplete,
  setBearerTokenDisabled,
  getMarketplaceDisabled,
  setMarketplaceDisabled,
  getPromoteFirstTailscaleOwner,
  setPromoteFirstTailscaleOwner,
  getDefaultModelId,
  setDefaultModelId,
  type CredentialsConfig,
  type CredentialMode,
} from './db.js';
import { listProviderContainerConfigNames } from '../../providers/provider-container-registry.js';

/** Auto-detect: the Codex provider is installed when it's registered a container config. */
function codexAvailable(): boolean {
  return listProviderContainerConfigNames().includes('codex');
}

// Cheap in-process guard against UserCreds abuse: a per-identity min-interval on
// credential connects + mint starts (prevents rapid reconnect / spawn churn).
// The host is single-process, so a Map suffices; paired with a global cap on
// concurrent mint containers (MAX_ACTIVE_MINTS) enforced at the start endpoints.
const userCredsActionAt = new Map<string, number>();
const USER_CREDS_MIN_INTERVAL_MS = 3000;
function userCredsRateLimited(userId: string, action: string): boolean {
  const key = `${userId}:${action}`;
  const now = Date.now();
  if (now - (userCredsActionAt.get(key) ?? 0) < USER_CREDS_MIN_INTERVAL_MS) return true;
  userCredsActionAt.set(key, now);
  return false;
}

import {
  storeUserCredential,
  revokeUserCredential,
  setWorkspaceDefaultCredential,
} from '../../modules/user-credentials/onboard.js';
import { WORKSPACE_DEFAULT_USER_ID } from '../../modules/user-credentials/identity.js';
import {
  startClaudeMint,
  mintClaudeToken,
  startCodexMint,
  finishCodexMint,
  cancelMint,
  activeMintCount,
  MAX_ACTIVE_MINTS,
} from './oauth-mint.js';
import { realOnecliAdmin } from '../../modules/user-credentials/onecli-admin.js';
import {
  userHasConnectedCredential,
  getUserCredential,
  listEnrolledGroups,
} from '../../modules/user-credentials/db.js';
import {
  getContainerConfig,
  updateContainerConfigJson,
  ensureContainerConfig,
  updateContainerConfigScalars,
} from '../../db/container-configs.js';
import {
  listSkillDrafts,
  getSkillDraft,
  readSkillDraftBody,
  resolveSkillDraft,
  updateSkillDraftBody,
} from '../../db/skill-drafts.js';
import type { SkillDraft } from '../../db/skill-drafts.js';
import { markRoomSkillDraftResolved } from './db.js';
import type { McpServerConfig } from '../../container-config.js';
import { validateMcpServerName } from '../../mcp-server-config.js';
import {
  assignMcpServerToAgent,
  createWebchatMcpServer,
  deleteWebchatMcpServer,
  getAgentsAssignedToMcpServer,
  getMcpServersForAgent,
  getWebchatMcpServer,
  getWebchatMcpServerByName,
  listWebchatMcpServers,
  pinMcpToolSurface,
  setMcpServerAuth,
  setMcpServerDrift,
  setMcpServerEnabledTools,
  syncAgentMcpConfig,
  unassignMcpServerFromAgent,
  updateWebchatMcpServer,
  type WebchatMcpServer,
  type WebchatMcpTransport,
  type WebchatMcpServerInput,
} from './mcp-registry.js';
import { probeMcpEndpoint } from './mcp-probe.js';
import { checkMcpServer } from './mcp-health.js';
import { finishOAuthFlow, parseMcpAuth, startOAuthFlow } from './mcp-auth.js';
import { broadcast, broadcastRooms } from './state.js';
import { setupWebSocket } from './ws.js';
import {
  findDuplicateScopedSkills,
  listArchivedSkills,
  promoteScopedSkill,
  restoreArchivedSkill,
} from '../../modules/learning/curator.js';
import { listRevisions, revertLastRevision, snapshotRevision } from '../../modules/learning/apply.js';
import { inspectSkillFiles } from '../../modules/skills/inspect.js';
import { applySkillDraft } from '../../modules/learning/apply.js';

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
  /** `threadId` is the session key (null = the room's main/default thread). */
  onInbound: (roomId: string, message: InboundMessage, threadId: string | null) => void;
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

  // Static PWA assets — the app shell that CONTAINS the login screen — must be
  // reachable BEFORE auth. Otherwise a token-only deployment (no localhost
  // auto-pass, no tailscale) 401s index.html/app.js and the user never sees the
  // field to enter their token. servePwa only serves real files under publicDir
  // (path-traversal guarded) and returns false for anything that isn't a file,
  // so every /api/* route still falls through to the auth gate below.
  if (method === 'GET' && servePwa(req, res, publicDir)) return;

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
      agents.map((a) => ({
        ...a,
        is_prime: a.id === primeAgentId,
        // Whether this agent auto-runs the learning review after busy turns.
        // Member-visible on purpose: the client uses it to suppress the manual
        // nudge (auto already ran — a tap would just double the review).
        learning_auto: parseAgentLearning(a.id).autoTrigger !== false,
      })),
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

  // ── UserCreds: per-room credential mode (admin) ────────────────────────────────
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

  // ── UserCreds OAuth: per-room toggle allowing subscription tokens (admin) ───────
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

  // ── UserCreds: workspace credentials policy — accepted TYPES + default room mode ──
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

  // ── UserCreds: a member connects / disconnects THEIR own Anthropic key ──────────
  // userId is the server-resolved caller — a user can only manage their own key.
  if (
    url.pathname === '/api/user-credentials/credential' &&
    (method === 'POST' || method === 'DELETE' || method === 'GET')
  ) {
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
    if (method === 'POST' && userCredsRateLimited(userId, 'connect'))
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
        // otherwise silently enable UserCreds in the member's other rooms.
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
            if (s.thread_id === userId) killContainer(s.id, 'UserCreds credential disconnected');
          }
        }
      }
    } catch (err) {
      log.error('UserCreds onboard/revoke failed', { userId, roomId, err: err instanceof Error ? err.message : err });
      return json(res, 502, { error: 'Credential setup failed — check OneCLI is running.' });
    }
    return json(res, 200, { ok: true });
  }

  // ── UserCreds OAuth browser-mint: get a setup-token without a terminal ──────────
  // A member signs in to their Claude subscription entirely in the browser; the
  // server runs `claude setup-token` in a throwaway container, scrapes the URL,
  // takes the pasted code, captures the token, and stores it as the member's
  // user-level credential — the same storage the paste path uses, minus the
  // terminal. Same gates as the OAuth paste path: room access + OAuth opt-in.
  const userCredsMintMatch = url.pathname.match(/^\/api\/user-credentials\/oauth\/(start|code|cancel)$/);
  if (userCredsMintMatch && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { roomId?: unknown; sessionId?: unknown; code?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    const step = userCredsMintMatch[1];
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
        if (userCredsRateLimited(userId, 'mint-start'))
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

  // ── UserCreds Codex browser-mint: connect a ChatGPT subscription without a terminal
  // `codex login --device-auth` runs in a throwaway container; the user enters
  // the pairing code at OpenAI's site (no code pasted back here). 'start' returns
  // the URL + code; 'finish' waits for the written auth.json and stores it as the
  // member's user-level Codex credential (→ an `openai` auth.json secret). Same
  // gates as the Claude mint: room access + the room's OAuth opt-in.
  const codexMintMatch = url.pathname.match(/^\/api\/user-credentials\/codex\/(start|finish|cancel)$/);
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
        if (userCredsRateLimited(userId, 'mint-start'))
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

  // ── Workspace DEFAULT logins (owner / global admin ONLY) ────────────────────────
  // The fallback credentials `all`-mode base agents auto-inject when a member has no
  // user credential of their own — `claude` (Anthropic key or subscription) and,
  // when the Codex provider is installed, `codex` (OpenAI key or ChatGPT
  // subscription). STRICTLY admin-only on EVERY verb incl. GET — a non-admin gets
  // 403 with no body, so even the existence/connection state of the defaults never
  // leaks (unlike /api/webchat/credentials-config, which is world-readable so room
  // UIs can see accepted types).
  if (url.pathname === '/api/workspace-credential' && (method === 'GET' || method === 'PUT' || method === 'DELETE')) {
    if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Forbidden' });
    const credState = (provider: 'claude' | 'codex') => {
      const row = getUserCredential(WORKSPACE_DEFAULT_USER_ID, provider);
      const connected = row?.status === 'active';
      return { connected, credType: connected ? (row?.cred_type ?? null) : null };
    };
    if (method === 'GET') {
      // Flat claude fields (the original shape) + a codex block + the workspace
      // default MODEL (the Ollama-engine analogue of the default credential).
      const defaultModelId = getDefaultModelId();
      const defaultModel = defaultModelId ? getWebchatModel(defaultModelId) : undefined;
      return json(res, 200, {
        ...credState('claude'),
        provider: 'claude',
        codex: credState('codex'),
        codexAvailable: codexAvailable(),
        defaultModelId: defaultModel?.id ?? null,
        defaultModelName: defaultModel ? `${defaultModel.name} (${defaultModel.model_id})` : null,
      });
    }
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    if (userCredsRateLimited(userId, 'connect'))
      return json(res, 429, { error: 'Too many attempts — wait a moment and try again.' });
    // Provider: PUT reads it from the body below; DELETE from the query string.
    try {
      if (method === 'DELETE') {
        const provider = url.searchParams.get('provider') === 'codex' ? 'codex' : 'claude';
        const priorOauth = credState(provider).credType === 'oauth_token';
        await revokeUserCredential(realOnecliAdmin, WORKSPACE_DEFAULT_USER_ID, provider);
        restartGroupsForWorkspaceCredChange(provider, priorOauth, false);
        return json(res, 200, { ok: true });
      }
      const raw = await readJsonBody(req, res);
      if (raw === null) return;
      let body: { provider?: unknown; type?: unknown; apiKey?: unknown; token?: unknown };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        return json(res, 400, { error: 'Invalid JSON' });
      }
      const provider = body.provider === 'codex' ? 'codex' : 'claude';
      if (provider === 'codex' && !codexAvailable())
        return json(res, 400, { error: 'Codex support isn’t installed yet — add it with /add-codex first.' });
      const priorOauth = credState(provider).credType === 'oauth_token';
      if (body.type === 'oauth_token') {
        const token = typeof body.token === 'string' ? body.token.trim() : '';
        if (provider === 'codex') {
          // A ChatGPT/Codex subscription = a whole auth.json (normally from the
          // browser mint; pasting is the fallback). Mirror the member validation.
          let ok = false;
          try {
            const parsed = JSON.parse(token) as Record<string, unknown>;
            ok = Boolean(parsed.tokens || parsed.OPENAI_API_KEY);
          } catch {
            ok = false;
          }
          if (!ok)
            return json(res, 400, {
              error: 'Expected a Codex auth.json — use “Connect with ChatGPT subscription” instead of pasting.',
            });
        } else if (!/^sk-ant-oat/.test(token)) {
          // Claude subscription: pasted `claude setup-token` output. The base-agent
          // sentinel wiring (user-credentials/index.ts env resolver) flips base
          // containers into OAuth mode to match.
          return json(res, 400, {
            error: 'Expected a Claude subscription token from `claude setup-token` (sk-ant-oat…)',
          });
        }
        await setWorkspaceDefaultCredential(realOnecliAdmin, provider, token, 'oauth_token');
        afterWorkspaceCredentialSet(provider, priorOauth, true);
        return json(res, 200, { ok: true });
      }
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (provider === 'codex') {
        if (!/^sk-/.test(apiKey)) return json(res, 400, { error: 'Expected an OpenAI API key (sk-…)' });
      } else if (!/^sk-ant-/.test(apiKey)) {
        return json(res, 400, { error: 'Expected an Anthropic API key (sk-ant-…)' });
      }
      await setWorkspaceDefaultCredential(realOnecliAdmin, provider, apiKey, 'api_key');
      afterWorkspaceCredentialSet(provider, priorOauth, false);
      return json(res, 200, { ok: true });
    } catch (err) {
      log.error('Workspace default credential failed', {
        userId,
        err: err instanceof Error ? err.message : err,
      });
      return json(res, 502, { error: 'Credential setup failed — check OneCLI is running.' });
    }
  }

  // ── Workspace-default OAuth browser-mint (owner / global admin ONLY) ────────────
  // Same throwaway-container `claude setup-token` flow as the per-member mint, but
  // the captured token is stored as the WORKSPACE DEFAULT (synthetic id), and the
  // gates are admin-only instead of room access + the member OAuth opt-in (that
  // policy governs members; the operator setting the workspace fallback is above it).
  const wsCredMintMatch = url.pathname.match(/^\/api\/workspace-credential\/oauth\/(start|code|cancel)$/);
  if (wsCredMintMatch && method === 'POST') {
    if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Forbidden' });
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { sessionId?: unknown; code?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    const step = wsCredMintMatch[1];
    if (step === 'cancel') {
      if (typeof body.sessionId === 'string') cancelMint(userId, body.sessionId);
      return json(res, 200, { ok: true });
    }
    try {
      if (step === 'start') {
        if (activeMintCount() >= MAX_ACTIVE_MINTS)
          return json(res, 429, { error: 'Too many sign-ins in progress — try again shortly.' });
        if (userCredsRateLimited(userId, 'mint-start'))
          return json(res, 429, { error: 'Too many attempts — wait a moment and try again.' });
        const { sessionId, url: signinUrl } = await startClaudeMint(userId);
        return json(res, 200, { sessionId, url: signinUrl });
      }
      // step === 'code': mint, then store as the workspace default. The spawn-time
      // sentinel mode may have changed (none/key → oauth) — respawn containers.
      if (typeof body.sessionId !== 'string' || typeof body.code !== 'string')
        return json(res, 400, { error: 'sessionId and code required' });
      const priorRow = getUserCredential(WORKSPACE_DEFAULT_USER_ID, 'claude');
      const priorOauth = priorRow?.status === 'active' && priorRow.cred_type === 'oauth_token';
      const token = await mintClaudeToken(userId, body.sessionId, body.code);
      await setWorkspaceDefaultCredential(realOnecliAdmin, 'claude', token, 'oauth_token');
      afterWorkspaceCredentialSet('claude', priorOauth, true);
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, 502, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── Workspace-default Codex browser-mint (owner / global admin ONLY) ────────────
  // Same `codex login --device-auth` throwaway-container flow as the per-member
  // Codex mint, but the captured auth.json is stored as the WORKSPACE DEFAULT
  // (synthetic id) `openai` secret that `all`-mode Codex base agents auto-inject.
  const wsCodexMintMatch = url.pathname.match(/^\/api\/workspace-credential\/codex\/(start|finish|cancel)$/);
  if (wsCodexMintMatch && method === 'POST') {
    if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Forbidden' });
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { sessionId?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    const step = wsCodexMintMatch[1];
    if (step === 'cancel') {
      if (typeof body.sessionId === 'string') cancelMint(userId, body.sessionId);
      return json(res, 200, { ok: true });
    }
    if (!codexAvailable())
      return json(res, 400, { error: 'Codex support isn’t installed yet — add it with /add-codex first.' });
    try {
      if (step === 'start') {
        if (activeMintCount() >= MAX_ACTIVE_MINTS)
          return json(res, 429, { error: 'Too many sign-ins in progress — try again shortly.' });
        if (userCredsRateLimited(userId, 'mint-start'))
          return json(res, 429, { error: 'Too many attempts — wait a moment and try again.' });
        const { sessionId, url: signinUrl, userCode } = await startCodexMint(userId);
        return json(res, 200, { sessionId, url: signinUrl, userCode });
      }
      // step === 'finish': wait for auth.json, then store as the workspace default.
      if (typeof body.sessionId !== 'string') return json(res, 400, { error: 'sessionId required' });
      const priorRow = getUserCredential(WORKSPACE_DEFAULT_USER_ID, 'codex');
      const priorOauth = priorRow?.status === 'active' && priorRow.cred_type === 'oauth_token';
      const authJson = await finishCodexMint(userId, body.sessionId);
      await setWorkspaceDefaultCredential(realOnecliAdmin, 'codex', authJson, 'oauth_token');
      afterWorkspaceCredentialSet('codex', priorOauth, true);
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, 502, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── Workspace DEFAULT model (owner / global admin ONLY) ─────────────────────────
  // The ollama-kind roster model every claude-family agent WITHOUT its own
  // assignment falls back to — what makes "default engine: Ollama" a true
  // workspace-wide default rather than a one-agent assignment. Same strict
  // admin gating as the workspace credential.
  if (url.pathname === '/api/workspace-model' && method === 'PUT') {
    if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Forbidden' });
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { modelId?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    if (body.modelId !== null) {
      if (typeof body.modelId !== 'string' || !body.modelId.trim())
        return json(res, 400, { error: 'modelId must be a string or null' });
      const model = getWebchatModel(body.modelId.trim());
      if (!model) return json(res, 404, { error: 'Model not found' });
      if (model.kind !== 'ollama')
        return json(res, 400, { error: 'The workspace default model must be an ollama roster model' });
      if (!model.endpoint) return json(res, 400, { error: 'That model has no endpoint to call' });
      setDefaultModelId(model.id);
    } else {
      setDefaultModelId(null);
    }
    refreshUnassignedGroupsForDefaultModel('Workspace default model changed');
    return json(res, 200, { ok: true, defaultModelId: getDefaultModelId() });
  }

  // ── First-run setup wizard state ────────────────────────────────────────────────
  // GET is authenticated (any member) so the client can decide whether to auto-open
  // the wizard; non-admins always get complete:true + canEdit:false so it never
  // blocks or shows for them. PUT (finish/dismiss/reset) is owner/global-admin only.
  if (url.pathname === '/api/webchat/onboarding' && (method === 'GET' || method === 'PUT')) {
    const canEdit = isOwner(userId) || isGlobalAdmin(userId);
    if (method === 'GET') {
      return json(res, 200, { complete: canEdit ? getOnboardingComplete() : true, canEdit });
    }
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    if (!canEdit) return json(res, 403, { error: 'Forbidden' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { complete?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    if (typeof body.complete !== 'boolean') return json(res, 400, { error: 'complete must be a boolean' });
    setOnboardingComplete(body.complete);
    return json(res, 200, { complete: body.complete });
  }

  // ── Feature toggles: MCP + skills marketplace ───────────────────────────────
  // GET is any authed user (the client hides the MCP/Skills tabs when off; non-
  // admins get the flag only). PUT is owner/global-admin — flips it on/off
  // (default on/recommended). Disabling also 403s the endpoints (gate above).
  if (url.pathname === '/api/webchat/features' && (method === 'GET' || method === 'PUT')) {
    const canEdit = isOwner(userId) || isGlobalAdmin(userId);
    if (method === 'GET') {
      return json(res, 200, { marketplaceEnabled: !getMarketplaceDisabled(), canEdit });
    }
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    if (!canEdit) return json(res, 403, { error: 'Forbidden' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { marketplaceEnabled?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    if (typeof body.marketplaceEnabled !== 'boolean') {
      return json(res, 400, { error: 'marketplaceEnabled must be a boolean' });
    }
    setMarketplaceDisabled(!body.marketplaceEnabled);
    return json(res, 200, { marketplaceEnabled: !getMarketplaceDisabled() });
  }

  // ── Wizard opt-in: first Tailscale login becomes owner ──────────────────────
  // One-shot arm flag. GET/PUT owner/global-admin only. PUT true → the next
  // tailscale identity to authenticate is promoted to owner (auth.ts finalize),
  // then the flag disarms itself.
  if (url.pathname === '/api/webchat/tailscale-owner' && (method === 'GET' || method === 'PUT')) {
    const canEdit = isOwner(userId) || isGlobalAdmin(userId);
    if (method === 'GET') {
      return json(res, 200, { armed: getPromoteFirstTailscaleOwner(), canEdit });
    }
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    if (!canEdit) return json(res, 403, { error: 'Forbidden' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { armed?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    if (typeof body.armed !== 'boolean') return json(res, 400, { error: 'armed must be a boolean' });
    setPromoteFirstTailscaleOwner(body.armed);
    return json(res, 200, { armed: getPromoteFirstTailscaleOwner() });
  }

  // ── Enable HTTPS over Tailscale (`tailscale serve`) ─────────────────────────
  // Owner/global-admin only. GET reports whether tailscaled is up, the https
  // URL, and whether serve is already on. POST runs `tailscale serve --bg
  // <port>` so webchat is reachable at https://<node>.ts.net with a real cert.
  // Identity continuity across the http→https switch lives in auth.ts
  // (tailscaleServeIdentity maps Serve's header back to the whois id).
  if (url.pathname === '/api/webchat/tailscale-https' && (method === 'GET' || method === 'POST')) {
    if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Forbidden' });
    if (method === 'GET') {
      return json(res, 200, await getTailscaleServeState());
    }
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const port = Number(process.env.WEBCHAT_PORT || DEFAULT_PORT);
    const result = await enableTailscaleServe(port);
    return json(res, result.ok ? 200 : 400, result);
  }

  // ── Access & security: retire the bearer token ──────────────────────────────
  // Owner/global-admin only. GET reports the auth-method picture so Settings can
  // offer to drop the bootstrap bearer token once Tailscale or SSO/trusted-proxy
  // (EntraID) is live. PUT flips it. Disabling is refused unless (a) something
  // else can authenticate server-side AND (b) THIS request already arrived via a
  // non-bearer method — so the admin proves the alternative works for their own
  // device and can't lock themselves (or everyone) out.
  if (url.pathname === '/api/webchat/auth' && method === 'GET') {
    if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Forbidden' });
    return json(res, 200, getAuthManagementInfo());
  }
  if (url.pathname === '/api/webchat/auth/bearer' && method === 'PUT') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Forbidden' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { active?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    if (typeof body.active !== 'boolean') return json(res, 400, { error: 'active must be a boolean' });
    const info = getAuthManagementInfo();
    if (!info.bearerConfigured) {
      return json(res, 400, { error: 'No bearer token is configured (WEBCHAT_TOKEN is unset).' });
    }
    if (body.active === false) {
      if (!info.hasAlternativeAuth) {
        return json(res, 400, {
          error:
            'Set up Tailscale or an SSO / trusted-proxy method first — disabling the bearer token now would leave no way to sign in.',
        });
      }
      if (auth.source === 'bearer') {
        return json(res, 400, {
          error:
            'Reconnect via Tailscale or SSO first, then disable the bearer token — otherwise this session would be locked out.',
        });
      }
      setBearerTokenDisabled(true);
    } else {
      setBearerTokenDisabled(false);
    }
    return json(res, 200, getAuthManagementInfo());
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

  // Reorder the caller's pinned rooms. Body: { order: string[] } — the desired
  // top-to-bottom room-id order. Per-user (setPinnedOrderForUser only touches
  // this user's pins; unknown/unpinned ids are ignored), so no per-room access
  // check is needed beyond the authenticated user. broadcastRooms re-syncs the
  // new order to the user's other devices.
  if (url.pathname === '/api/rooms/pins/order' && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') {
      return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    }
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { order?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    if (!Array.isArray(body.order) || body.order.some((x) => typeof x !== 'string')) {
      return json(res, 400, { error: 'order must be an array of room id strings' });
    }
    setPinnedOrderForUser(userId, body.order as string[]);
    broadcastRooms();
    return json(res, 200, { ok: true });
  }

  // ── Engage mode (room-scoped) ──
  // Controls what `recomputeEngagePatterns` rewrites un-primed wirings to:
  //   'mention-only' — agents fire only on explicit @-mention (no fallback).
  // This is the only mode; the legacy 'broadcast' (every wired agent answers
  // every message) has been retired.
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
    if (body.mode !== 'mention-only') {
      return json(res, 400, { error: "mode must be 'mention-only'" });
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

  // ── Threads (per-room) ────────────────────────────────────────────────
  // A thread maps to an agent session; see docs/webchat/threads.md.
  // List/read/create/rename are member-gated; delete (destroys history + tears
  // down the thread's session) is owner-only.
  const roomThreadReadMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/threads\/([^/]+)\/read$/);
  if (roomThreadReadMatch && method === 'PUT') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const roomId = decodeURIComponent(roomThreadReadMatch[1]);
    const threadId = decodeURIComponent(roomThreadReadMatch[2]);
    if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
    if (!canAccessRoom(userId, roomId)) return json(res, 403, { error: 'Access denied' });
    markThreadRead(userId, roomId, threadId);
    return json(res, 200, { ok: true });
  }

  const roomThreadsMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/threads$/);
  if (roomThreadsMatch && method === 'GET') {
    const roomId = decodeURIComponent(roomThreadsMatch[1]);
    if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
    if (!canAccessRoom(userId, roomId)) return json(res, 403, { error: 'Access denied' });
    ensureMainThread(roomId); // every room has a main thread once listed
    const unread = getUnreadThreadIdsForRoom(userId, roomId);
    return json(
      res,
      200,
      listWebchatThreads(roomId).map((t) => ({ ...t, unread: unread.has(t.thread_id) })),
    );
  }
  if (roomThreadsMatch && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const roomId = decodeURIComponent(roomThreadsMatch[1]);
    if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
    if (!canAccessRoom(userId, roomId)) return json(res, 403, { error: 'Access denied' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { title?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    const title = sanitizeThreadTitle(body.title);
    if (title === null) return json(res, 400, { error: 'title must be 1–80 characters' });
    const thread = createWebchatThread(roomId, title);
    broadcastRooms(); // refresh each client's sidebar thread-count chevron
    return json(res, 200, thread);
  }

  const roomThreadMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/threads\/([^/]+)$/);
  if (roomThreadMatch && method === 'PATCH') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const roomId = decodeURIComponent(roomThreadMatch[1]);
    const threadId = decodeURIComponent(roomThreadMatch[2]);
    if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
    if (!canAccessRoom(userId, roomId)) return json(res, 403, { error: 'Access denied' });
    if (!getWebchatThread(roomId, threadId)) return json(res, 404, { error: 'Thread not found' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { title?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    const title = sanitizeThreadTitle(body.title);
    if (title === null) return json(res, 400, { error: 'title must be 1–80 characters' });
    renameWebchatThread(roomId, threadId, title);
    return json(res, 200, { ok: true, title });
  }
  if (roomThreadMatch && method === 'DELETE') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    const roomId = decodeURIComponent(roomThreadMatch[1]);
    const threadId = decodeURIComponent(roomThreadMatch[2]);
    if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
    if (threadId === 'main') return json(res, 400, { error: 'The main thread cannot be deleted' });
    if (!getWebchatThread(roomId, threadId)) return json(res, 404, { error: 'Thread not found' });
    return deleteThreadHandler(res, roomId, threadId);
  }

  // ── Thread context sync (pull main → thread / push thread → main) ──
  // Both are verbatim + additive: copy the source's native message delta into
  // the destination, seed the destination agent session(s) as silent context,
  // broadcast the copies, and advance the per-thread high-water mark so repeat
  // syncs only carry genuinely new messages. The 'main' regular chat is the
  // shared trunk; only a topic thread can pull from / push to it.
  // See docs/webchat/thread-context-sync.md.
  const roomThreadPullMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/threads\/([^/]+)\/(pull|push)$/);
  if (roomThreadPullMatch && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const roomId = decodeURIComponent(roomThreadPullMatch[1]);
    const threadId = decodeURIComponent(roomThreadPullMatch[2]);
    const dir = roomThreadPullMatch[3] as 'pull' | 'push';
    if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
    if (!canAccessRoom(userId, roomId)) return json(res, 403, { error: 'Access denied' });
    if (threadId === MAIN_THREAD) return json(res, 400, { error: 'The regular chat has no main to sync with' });
    if (!getWebchatThread(roomId, threadId)) return json(res, 404, { error: 'Thread not found' });
    const copied =
      dir === 'pull'
        ? syncThreadContext({
            roomId,
            srcThreadId: MAIN_THREAD,
            destThreadId: threadId,
            markThreadId: threadId,
            direction: 'pulled',
            dividerText: 'Pulled from main chat',
            freshLimit: FRESH_SYNC_LIMIT,
          })
        : syncThreadContext({
            roomId,
            srcThreadId: threadId,
            destThreadId: MAIN_THREAD,
            markThreadId: threadId,
            direction: 'pushed',
            dividerText: 'Pushed from thread',
            freshLimit: FRESH_SYNC_LIMIT,
          });
    return json(res, 200, { copied });
  }

  // ── Engaged agents (per-thread set) — DORMANT ──
  // The engaged-agents routing model is disabled (see the dormancy note in
  // index.ts): nothing registers setEngagedResolver, so the stored set has no
  // routing effect and no client calls these routes. They are gated OFF behind
  // ENGAGED_AGENTS_ENABLED rather than left live-but-inert — a write that does
  // nothing is a footgun. When off, the routes fall through to the default 404.
  // To bring the subsystem back: flip this flag AND add the setEngagedResolver
  // wiring. GET lists, POST engages, DELETE disengages; the 'main' thread can
  // never engage. See docs/webchat/thread-engaged-agents.md.
  const ENGAGED_AGENTS_ENABLED: boolean = false;
  const roomThreadEngagedMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/threads\/([^/]+)\/engaged$/);
  if (ENGAGED_AGENTS_ENABLED && roomThreadEngagedMatch && method === 'GET') {
    const roomId = decodeURIComponent(roomThreadEngagedMatch[1]);
    const threadId = decodeURIComponent(roomThreadEngagedMatch[2]);
    if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
    if (!canAccessRoom(userId, roomId)) return json(res, 403, { error: 'Access denied' });
    return json(res, 200, engagedAgentsForThread(roomId, threadId));
  }
  if (ENGAGED_AGENTS_ENABLED && roomThreadEngagedMatch && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const roomId = decodeURIComponent(roomThreadEngagedMatch[1]);
    const threadId = decodeURIComponent(roomThreadEngagedMatch[2]);
    if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
    if (!canAccessRoom(userId, roomId)) return json(res, 403, { error: 'Access denied' });
    if (threadId === 'main') return json(res, 400, { error: 'The regular chat cannot engage agents' });
    if (!getWebchatThread(roomId, threadId)) return json(res, 404, { error: 'Thread not found' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { agentGroupId?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    const agentGroupId = typeof body.agentGroupId === 'string' ? body.agentGroupId : '';
    // Only agents actually wired to this room can be engaged.
    if (!getAgentsForWebchatRoom(roomId).some((a) => a.id === agentGroupId)) {
      return json(res, 400, { error: 'Agent is not wired to this room' });
    }
    engageAgent(roomId, threadId, agentGroupId);
    broadcastEngagedSet(roomId, threadId);
    return json(res, 200, { ok: true, engaged: engagedAgentsForThread(roomId, threadId) });
  }
  const roomThreadDisengageMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/threads\/([^/]+)\/engaged\/([^/]+)$/);
  if (ENGAGED_AGENTS_ENABLED && roomThreadDisengageMatch && method === 'DELETE') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const roomId = decodeURIComponent(roomThreadDisengageMatch[1]);
    const threadId = decodeURIComponent(roomThreadDisengageMatch[2]);
    const agentGroupId = decodeURIComponent(roomThreadDisengageMatch[3]);
    if (!getWebchatRoom(roomId)) return json(res, 404, { error: 'Room not found' });
    if (!canAccessRoom(userId, roomId)) return json(res, 403, { error: 'Access denied' });
    disengageAgent(roomId, threadId, agentGroupId);
    broadcastEngagedSet(roomId, threadId);
    return json(res, 200, { ok: true, engaged: engagedAgentsForThread(roomId, threadId) });
  }

  // Room → agent → model topology for the explore view, scoped to the caller's
  // accessible rooms (and only the agents/models reachable from them).
  if (url.pathname === '/api/topology' && method === 'GET') {
    const rooms = filterRoomsForUser(userId, getAllWebchatRooms());
    // ALL agents the caller manages become columns/nodes (not just wired ones),
    // so unused agents show as orphans and can be wired from the matrix.
    const agents = listAgentsForUser(userId).map((a) => ({ id: a.id, name: a.name }));
    const topo = getWebchatTopology(rooms, agents);
    // SCOPED skills only — the ones wired to a specific agent (including anything
    // the learning loop produced). The shared pool is on ~every agent, so drawing
    // it would add hundreds of identical edges that say nothing about any one
    // agent; it stays visible in the agent's own settings. A skill wired to two
    // agents is ONE node with two edges — that's the fact worth seeing.
    const skillMap = new Map<string, { id: string; name: string; origin: string | null }>();
    const skillEdges: { agent: string; skill: string }[] = [];
    for (const a of agents) {
      for (const sk of listScopedSkills(a.id)) {
        if (!skillMap.has(sk.name)) {
          skillMap.set(sk.name, { id: sk.name, name: sk.name, origin: sk.origin?.label ?? null });
        }
        skillEdges.push({ agent: a.id, skill: sk.name });
      }
    }
    return json(res, 200, { ...topo, skills: [...skillMap.values()], skillEdges });
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
    // Optional thread filter — absent = the whole room (back-compat).
    const threadId = url.searchParams.get('thread_id') || undefined;
    const msgs = afterId
      ? getWebchatMessagesAfterId(room.id, afterId, 200, threadId)
      : beforeId
        ? getWebchatMessagesBeforeId(room.id, beforeId, 50, threadId)
        : getWebchatMessages(room.id, 100, threadId);
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
    return handleMultipartUpload(
      req,
      res,
      roomId,
      senderIdentity,
      userId,
      hooks,
      url.searchParams.get('thread_id') || undefined,
    );
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
    return handleChunkedUpload(
      req,
      res,
      roomId,
      senderIdentity,
      userId,
      hooks,
      url.searchParams.get('thread_id') || undefined,
    );
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

  // ── MCP servers (registry + per-agent assignment) ──────────────────────
  // A registry of MCP tool servers (webchat_mcp_servers) mirroring the models
  // registry: define a server once (owner-gated CRUD + a probe that connects
  // as a real MCP client and lists the server's tools), then attach it to any
  // number of agents. Assignment syncs container_configs.mcp_servers — the
  // same field `ncl groups config add-mcp-server` writes and the container
  // reads — and restarts the group's containers. List responses never include
  // env/headers (they may hold credentials).
  // MCP + skills marketplace can be turned off workspace-wide (hardened installs
  // — both are code-execution surfaces). Gate every management endpoint at the
  // server, not just the UI, per the admin-surface rule (DOM hide + server 403).
  if (
    (url.pathname === '/api/mcp-servers' ||
      url.pathname.startsWith('/api/mcp-servers/') ||
      url.pathname === '/api/skills' ||
      url.pathname.startsWith('/api/skills/')) &&
    getMarketplaceDisabled()
  ) {
    return json(res, 403, { error: 'MCP and the skills marketplace are disabled by the workspace owner.' });
  }

  // MCP registry is admin-only (scoped admin or higher) — end to end.
  if (url.pathname === '/api/mcp-servers' && method === 'GET') {
    if (!isAnyAdmin(userId)) return json(res, 403, { error: 'Admin privilege required' });
    return json(res, 200, listMcpServersForUI());
  }
  if (url.pathname === '/api/mcp-servers' && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    if (!isAnyAdmin(userId)) return json(res, 403, { error: 'Admin privilege required' });
    return createMcpServerHandler(req, res);
  }
  // Read-only discovery over the public MCP registry. Admin-gated like the rest of
  // the MCP surface; adds no write path (a row prefills the existing add form, so
  // every server still goes through probe → create).
  if (url.pathname === '/api/mcp-sources' && method === 'GET') {
    if (!isAnyAdmin(userId)) return json(res, 403, { error: 'Admin privilege required' });
    return json(res, 200, {
      sources: [{ ...MCP_REGISTRY_SOURCE, disabled: isSourceDisabled(MCP_REGISTRY_ID) }],
    });
  }
  const mcpSourceMatch = url.pathname.match(/^\/api\/mcp-sources\/([^/]+)$/);
  if (mcpSourceMatch && method === 'PUT') {
    if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Global admin required' });
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const id = decodeURIComponent(mcpSourceMatch[1]);
    if (id !== MCP_REGISTRY_ID) return json(res, 404, { error: 'Unknown source' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let disabled = false;
    try {
      disabled = !!(JSON.parse(raw) as { disabled?: unknown }).disabled;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    setSourceDisabled(MCP_REGISTRY_ID, disabled);
    return json(res, 200, { ok: true, disabled });
  }
  if (url.pathname === '/api/mcp-catalog' && method === 'GET') {
    if (!isAnyAdmin(userId)) return json(res, 403, { error: 'Admin privilege required' });
    return mcpCatalogHandler(res, url.searchParams.get('q') || '');
  }
  if (url.pathname === '/api/mcp-servers/probe' && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    if (!isAnyAdmin(userId)) return json(res, 403, { error: 'Admin privilege required' });
    return probeMcpServerHandler(req, res);
  }
  // OAuth callback: the admin's browser lands here from the authorization
  // server. Auth = whois like everything else, plus the single-use state.
  if (url.pathname === '/api/mcp-servers/oauth/callback' && method === 'GET') {
    const code = url.searchParams.get('code') || '';
    const state = url.searchParams.get('state') || '';
    if (!code || !state) return json(res, 400, { error: 'Missing code/state' });
    try {
      const { serverId } = await finishOAuthFlow(state, code);
      const server = getWebchatMcpServer(serverId);
      if (server) {
        // Re-sync every assigned agent onto the relay URL now that auth exists.
        for (const gid of getAgentsAssignedToMcpServer(serverId)) {
          syncAgentMcpConfig(gid, server, true);
          reloadAgentMcpServers(gid);
        }
        void checkMcpServer(server).catch(() => {});
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><meta charset="utf-8"><title>Connected</title><body style="font-family:system-ui;padding:2rem">✅ MCP server connected — you can close this tab and return to NanoClaw.</body>',
      );
      return;
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Failed</title><body style="font-family:system-ui;padding:2rem">OAuth failed: ${escapeHtml(err instanceof Error ? err.message : String(err))}</body>`,
      );
      return;
    }
  }
  const mcpOauthStartMatch = url.pathname.match(/^\/api\/mcp-servers\/([^/]+)\/oauth\/start$/);
  if (mcpOauthStartMatch && method === 'POST') {
    if (!isAnyAdmin(userId)) return json(res, 403, { error: 'Admin privilege required' });
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let staticClient: { client_id: string; client_secret?: string } | undefined;
    try {
      const b = JSON.parse(raw || '{}') as { client_id?: string; client_secret?: string };
      if (b.client_id) staticClient = { client_id: String(b.client_id), client_secret: b.client_secret };
    } catch {
      /* empty body is fine */
    }
    const host = String(req.headers.host || '');
    if (!host) return json(res, 400, { error: 'Missing Host header' });
    const redirectUri = `https://${host}/api/mcp-servers/oauth/callback`;
    try {
      const authorizeUrl = await startOAuthFlow(decodeURIComponent(mcpOauthStartMatch[1]), redirectUri, staticClient);
      return json(res, 200, { authorizeUrl });
    } catch (err) {
      return json(res, 422, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  // Re-approve a drifted tool surface: pin what the server exposes NOW.
  const mcpRepinMatch = url.pathname.match(/^\/api\/mcp-servers\/([^/]+)\/repin$/);
  if (mcpRepinMatch && method === 'POST') {
    if (!isAnyAdmin(userId)) return json(res, 403, { error: 'Admin privilege required' });
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const server = getWebchatMcpServer(decodeURIComponent(mcpRepinMatch[1]));
    if (!server) return json(res, 404, { error: 'MCP server not found' });
    if (server.transport === 'stdio' || !server.url) return json(res, 400, { error: 'Only remote servers are pinned' });
    setMcpServerDrift(server.id, null);
    getDb().prepare(`UPDATE webchat_mcp_servers SET pinned_tools = NULL WHERE id = ?`).run(server.id);
    const health = await checkMcpServer(getWebchatMcpServer(server.id)!); // re-probe pins the current surface
    return json(res, 200, { ok: true, health });
  }
  // Tool allowlist for a server (null/empty = all tools). Flows into each
  // assigned agent's container config → the SDK's allowedTools filter.
  const mcpToolsMatch = url.pathname.match(/^\/api\/mcp-servers\/([^/]+)\/tools$/);
  if (mcpToolsMatch && method === 'PUT') {
    if (!isAnyAdmin(userId)) return json(res, 403, { error: 'Admin privilege required' });
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const server = getWebchatMcpServer(decodeURIComponent(mcpToolsMatch[1]));
    if (!server) return json(res, 404, { error: 'MCP server not found' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let enabled: string[] | null = null;
    try {
      const b = JSON.parse(raw) as { enabled?: unknown };
      if (Array.isArray(b.enabled)) enabled = b.enabled.map(String).slice(0, 500);
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    setMcpServerEnabledTools(server.id, enabled && enabled.length ? enabled : null);
    const updated = getWebchatMcpServer(server.id)!;
    for (const gid of getAgentsAssignedToMcpServer(server.id)) {
      syncAgentMcpConfig(gid, updated, true);
      reloadAgentMcpServers(gid);
    }
    return json(res, 200, { ok: true });
  }
  // Host-side credential for a server: {token} sets a bearer secret, null
  // clears. Never echoed back; containers switch to the relay on next sync.
  const mcpAuthMatch = url.pathname.match(/^\/api\/mcp-servers\/([^/]+)\/auth$/);
  if (mcpAuthMatch && method === 'PUT') {
    if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Global admin required' });
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const server = getWebchatMcpServer(decodeURIComponent(mcpAuthMatch[1]));
    if (!server) return json(res, 404, { error: 'MCP server not found' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let token: string | null = null;
    try {
      const b = JSON.parse(raw) as { token?: unknown };
      token = typeof b.token === 'string' && b.token.trim() ? b.token.trim() : null;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    setMcpServerAuth(server.id, token ? { kind: 'bearer', token } : null);
    const updated = getWebchatMcpServer(server.id)!;
    for (const gid of getAgentsAssignedToMcpServer(server.id)) {
      syncAgentMcpConfig(gid, updated, true);
      reloadAgentMcpServers(gid);
    }
    return json(res, 200, { ok: true, hasAuth: !!token });
  }
  const mcpServerIdMatch = url.pathname.match(/^\/api\/mcp-servers\/([^/]+)$/);
  if (mcpServerIdMatch && method === 'PUT') {
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    return updateMcpServerHandler(req, res, decodeURIComponent(mcpServerIdMatch[1]));
  }
  if (mcpServerIdMatch && method === 'DELETE') {
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    return deleteMcpServerHandler(res, decodeURIComponent(mcpServerIdMatch[1]), url.searchParams.get('force') === '1');
  }
  const agentMcpMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/mcp-servers$/);
  if (agentMcpMatch && (method === 'GET' || method === 'PUT')) {
    const group = resolveAgent(decodeURIComponent(agentMcpMatch[1]));
    if (!group) return json(res, 404, { error: 'Agent not found' });
    if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
    if (method === 'GET') return listAgentMcpHandler(res, group.id);
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    return setAgentMcpHandler(req, res, group.id);
  }

  // ── Skills (per-agent capability toggles) ──────────────────────────────
  // Available skills = the folders in container/skills (bind-mounted read-only
  // into every container); each agent's container config picks which it gets.
  if (url.pathname === '/api/skills' && method === 'GET') {
    if (!isAnyAdmin(userId)) return json(res, 403, { error: 'Admin privilege required' });
    return json(res, 200, { skills: listAvailableSkills() });
  }
  // Import a skill from a GitHub folder URL into data/user-skills (no rebuild).
  // Owner/global-admin only: an imported skill lands in a shared mount that fans
  // out to every 'all' agent install-wide, so importing code is an install-wide
  // trust action (same bar as the source registry), NOT a per-group one — a
  // scoped admin of one group must not be able to inject code into others'.
  if (url.pathname === '/api/skills/import' && method === 'POST') {
    if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Global admin required' });
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    return importSkillHandler(req, res);
  }
  // One merged pool of skills for a trust tier (official = Anthropic; community =
  // every community GitHub collection + the awesomeskill.ai marketplace). `q`
  // filters/searches the pool. Community results are unvetted — the UI warns +
  // gates import behind a review confirm.
  if (url.pathname === '/api/skills/catalog' && method === 'GET') {
    if (!isAnyAdmin(userId)) return json(res, 403, { error: 'Admin privilege required' });
    return catalogPoolHandler(res, url.searchParams.get('tier') || 'official', url.searchParams.get('q') || '');
  }
  // Suggest skills (installed + catalogs) matching a new agent's description.
  if (url.pathname === '/api/skills/suggest' && method === 'GET') {
    if (!isAnyAdmin(userId)) return json(res, 403, { error: 'Admin privilege required' });
    return suggestSkillsHandler(res, url.searchParams.get('text') || '');
  }
  // Catalog-source registry: list is admin-visible; changes are global-admin
  // only ("well-known sites" are an install-wide trust decision).
  // NOTE: these literal routes must stay ABOVE the /api/skills/:name matcher.
  if (url.pathname === '/api/skills/sources' && method === 'GET') {
    if (!isAnyAdmin(userId)) return json(res, 403, { error: 'Admin privilege required' });
    // `sources` = editable GitHub collections; `builtins` = code-wired sources
    // that also feed the pool but have nothing to edit (the marketplace).
    return json(res, 200, {
      sources: listSkillSources(),
      builtins: [
        {
          id: MARKETPLACE_ID,
          label: SKILL_DISCOVERY_SOURCE.name,
          url: SKILL_DISCOVERY_SOURCE.url,
          disabled: isSourceDisabled(MARKETPLACE_ID),
        },
      ],
    });
  }
  const skillSourceMatch = url.pathname.match(/^\/api\/skills\/sources\/([^/]+)$/);
  if (skillSourceMatch && (method === 'PUT' || method === 'DELETE')) {
    if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Global admin required' });
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const sourceId = decodeURIComponent(skillSourceMatch[1]);
    // Built-in marketplace: there's nothing in the DB to edit/delete — DELETE
    // switches it off (removed from the pool), PUT switches it back on.
    if (sourceId === MARKETPLACE_ID) {
      setSourceDisabled(MARKETPLACE_ID, method === 'DELETE');
      return json(res, 200, { ok: true });
    }
    if (method === 'PUT') return putSkillSourceHandler(req, res, sourceId);
    catalogCache.delete(sourceId);
    return deleteSkillSource(sourceId) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Source not found' });
  }
  // Delete a user skill (imported/uploaded). Shipped skills can't be removed.
  // Read / write / delete a single skill. GET returns its SKILL.md (any
  // source); PUT creates or edits a USER skill's SKILL.md (shipped skills are
  // read-only — they're repo files); DELETE removes a user skill.
  // Cross-agent duplicates + promotion (learning loop). Detection is read-only
  // and admin-visible; PROMOTION writes the shared pool — install-wide reach —
  // so it stays owner/global-admin, the pool's own boundary.
  // Pre-import inspection: fetch the skill's files WITHOUT writing anything and
  // return the "what's inside" inventory + lint findings. Read-only, so any
  // admin may look (per-group admins import scoped skills through the same
  // preview). NOTE: literal /api/skills/* routes must stay ABOVE the
  // /api/skills/:name matcher.
  if (url.pathname === '/api/skills/inspect' && method === 'POST') {
    if (!isAnyAdmin(userId)) return json(res, 403, { error: 'Admin privilege required' });
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    return inspectSkillHandler(req, res);
  }
  // Update checks for pinned pool imports: which user skills' upstream has
  // moved since their recorded commit. Read-only.
  if (url.pathname === '/api/skills/updates' && method === 'GET') {
    if (!isAnyAdmin(userId)) return json(res, 403, { error: 'Admin privilege required' });
    return skillUpdatesHandler(res);
  }
  const skillUpdateMatch = url.pathname.match(/^\/api\/skills\/([^/]+)\/update$/);
  if (skillUpdateMatch && method === 'POST') {
    // Same gate as pool import — an update IS a pool import.
    if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Global admin required' });
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    return applySkillUpdateHandler(res, decodeURIComponent(skillUpdateMatch[1]));
  }
  if (url.pathname === '/api/skills/duplicates' && method === 'GET') {
    if (!isAnyAdmin(userId)) return json(res, 403, { error: 'Admin privilege required' });
    const dups = findDuplicateScopedSkills().map((d) => ({
      ...d,
      agents: d.agents.map((id) => getAgentGroup(id)?.name || id),
    }));
    return json(res, 200, { duplicates: dups });
  }
  if (url.pathname === '/api/skills/promote' && method === 'POST') {
    if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Global admin required' });
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let name = '';
    try {
      name = sanitizeSkillName(String((JSON.parse(raw) as { name?: unknown }).name || ''));
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    if (!name) return json(res, 400, { error: 'Invalid skill name' });
    const dup = findDuplicateScopedSkills().find((d) => d.name === name);
    const r = promoteScopedSkill(name);
    if (!r.ok) return json(res, 409, { error: r.error });
    // Every holder's containers must respawn to see the pooled copy.
    let restarted = 0;
    for (const g of listAgentsForUser(userId)) {
      if (dup?.agents.includes(g.id)) restarted += restartAgentGroupContainers(g.id, 'Skill promoted to shared pool');
    }
    return json(res, 200, { ok: true, restarted });
  }
  const skillItemMatch = url.pathname.match(/^\/api\/skills\/([^/]+)$/);
  if (skillItemMatch && (method === 'GET' || method === 'PUT' || method === 'DELETE')) {
    if (!isAnyAdmin(userId)) return json(res, 403, { error: 'Admin privilege required' });
    const skillName = decodeURIComponent(skillItemMatch[1]);
    if (method === 'GET') return getSkillContentHandler(res, skillName); // viewing is fine for any admin
    // Writing a skill (create/edit/delete) introduces code that fans out to every
    // 'all' agent install-wide → owner/global-admin only, like import.
    if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Global admin required' });
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    if (method === 'PUT') return putUserSkillHandler(req, res, skillName);
    return deleteUserSkillHandler(res, skillName);
  }
  const agentSkillsMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/skills$/);
  if (agentSkillsMatch && (method === 'GET' || method === 'PUT')) {
    const group = resolveAgent(decodeURIComponent(agentSkillsMatch[1]));
    if (!group) return json(res, 404, { error: 'Agent not found' });
    if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
    if (method === 'GET') {
      const available = listAvailableSkills();
      // getContainerConfig returns the raw row — skills is a JSON string ("all"
      // or a name array), so parse it (configFromDb does the same).
      let sel: string[] | 'all' = 'all';
      try {
        const rawSkills = getContainerConfig(group.id)?.skills;
        if (rawSkills != null) sel = JSON.parse(rawSkills) as string[] | 'all';
      } catch {
        sel = 'all';
      }
      const enabled = sel === 'all' ? available.map((s) => s.name) : sel;
      // Also surface skills wired to THIS agent only (real dirs in its own
      // .claude-shared/skills), which the shared pool doesn't include.
      return json(res, 200, {
        available,
        enabled,
        scoped: listScopedSkills(group.id),
        // Curator output: scoped skills archived for disuse. Restorable, never deleted.
        archived: listArchivedSkills(group.id),
      });
    }
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    return setAgentSkillsHandler(req, res, group.id);
  }
  // Import a skill wired to ONE agent (its own .claude-shared/skills), so it
  // reaches only that group — never the shared pool / other 'all' agents.
  // Per-group admin is sufficient: it can't affect any other group.
  const agentSkillImportMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/skills\/import$/);
  if (agentSkillImportMatch && method === 'POST') {
    const group = resolveAgent(decodeURIComponent(agentSkillImportMatch[1]));
    if (!group) return json(res, 404, { error: 'Agent not found' });
    if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    return importScopedSkillHandler(req, res, group.id);
  }
  // Learning-loop settings, per agent. Two toggles, two owners (docs/learning-loop.md):
  //   autoTrigger — spends tokens, stages drafts → per-agent ADMIN.
  //   autoKeep    — writes live agent context unreviewed → OWNER/GLOBAL ADMIN only,
  //                 the same boundary as every other skill write.
  const agentLearningMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/learning$/);
  if (agentLearningMatch && (method === 'GET' || method === 'PUT')) {
    const group = resolveAgent(decodeURIComponent(agentLearningMatch[1]));
    if (!group) return json(res, 404, { error: 'Agent not found' });
    if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
    const current = parseAgentLearning(group.id);
    // Auto-keep is admin-tier like the manual Keep it automates: a scoped admin
    // can already keep any draft for their agent with a tap, so gating the
    // toggle higher only added friction, not protection. The blast radius is
    // unchanged — a kept skill is scoped to the one agent they administer.
    const canAutoKeep = hasAdminPrivilege(userId, group.id);
    if (method === 'GET') {
      return json(res, 200, {
        autoTrigger: current.autoTrigger !== false, // absent = on
        autoKeep: current.autoKeep === true, // absent = off
        canAutoKeep,
      });
    }
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { autoTrigger?: unknown; autoKeep?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    const next = { ...current };
    if (typeof body.autoTrigger === 'boolean') next.autoTrigger = body.autoTrigger;
    if (typeof body.autoKeep === 'boolean') {
      if (!canAutoKeep) return json(res, 403, { error: 'Admin privilege required for auto-keep' });
      next.autoKeep = body.autoKeep;
    }
    updateContainerConfigJson(group.id, 'learning', next);
    // Config materializes at spawn — restart so the container sees it now.
    const restarted = restartAgentGroupContainers(group.id, 'Learning settings changed');
    return json(res, 200, {
      ok: true,
      autoTrigger: next.autoTrigger !== false,
      autoKeep: next.autoKeep === true,
      canAutoKeep,
      restarted,
    });
  }
  const skillRevertMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/skills\/scoped\/([^/]+)\/revert$/);
  if (skillRevertMatch && method === 'POST') {
    const group = resolveAgent(decodeURIComponent(skillRevertMatch[1]));
    if (!group) return json(res, 404, { error: 'Agent not found' });
    if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const name = sanitizeSkillName(decodeURIComponent(skillRevertMatch[2]));
    if (!name) return json(res, 400, { error: 'Invalid skill name' });
    const r = revertLastRevision(scopedSkillsDir(group.id), name);
    if (!r.ok) return json(res, 409, { error: r.error });
    const restarted = restartAgentGroupContainers(group.id, 'Skill revision reverted');
    return json(res, 200, { ok: true, restarted });
  }
  const skillRestoreMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/skills\/archived\/([^/]+)\/restore$/);
  if (skillRestoreMatch && method === 'POST') {
    const group = resolveAgent(decodeURIComponent(skillRestoreMatch[1]));
    if (!group) return json(res, 404, { error: 'Agent not found' });
    if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const name = sanitizeSkillName(decodeURIComponent(skillRestoreMatch[2]));
    if (!name) return json(res, 400, { error: 'Invalid skill name' });
    const r = restoreArchivedSkill(group.id, name);
    if (!r.ok) return json(res, 409, { error: r.error });
    const restarted = restartAgentGroupContainers(group.id, 'Webchat archived skill restored');
    return json(res, 200, { ok: true, restarted });
  }
  const agentScopedSkillMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/skills\/scoped\/([^/]+)$/);
  if (agentScopedSkillMatch && method === 'DELETE') {
    const group = resolveAgent(decodeURIComponent(agentScopedSkillMatch[1]));
    if (!group) return json(res, 404, { error: 'Agent not found' });
    if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    return deleteScopedSkillHandler(res, group.id, decodeURIComponent(agentScopedSkillMatch[2]));
  }

  // ── Learning loop: skill drafts (proposed skills awaiting review) ───────
  if (url.pathname === '/api/skill-drafts' && method === 'GET') {
    if (!isAnyAdmin(userId)) return json(res, 403, { error: 'Admin privilege required' });
    const drafts = listSkillDrafts().map((d) => ({
      id: d.id,
      skillName: d.skill_name,
      description: d.description,
      kind: d.kind,
      targetSkill: d.target_skill,
      agentGroupId: d.agent_group_id,
      agentName: getAgentGroup(d.agent_group_id)?.name || d.agent_group_id,
      createdAt: d.created_at,
      // The conversation this draft was distilled FROM — reviewing a skill
      // without the session that produced it is guessing.
      roomId: draftSourceRoom(d.session_id),
    }));
    return json(res, 200, { drafts });
  }
  const draftMatch = url.pathname.match(/^\/api\/skill-drafts\/([^/]+)$/);
  if (draftMatch && method === 'PUT') {
    // Edit a pending draft's body before keeping it. Same tier as Keep: admin
    // over the agent the draft belongs to — editing shapes what gets kept.
    const id = decodeURIComponent(draftMatch[1]);
    const draft = getSkillDraft(id);
    if (!draft || draft.status !== 'pending') return json(res, 404, { error: 'Draft not found' });
    if (!hasAdminPrivilege(userId, draft.agent_group_id)) return json(res, 403, { error: 'Admin privilege required' });
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body = '';
    try {
      body = String((JSON.parse(raw) as { body?: unknown }).body || '');
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    if (!/^---\s*\n[\s\S]*?description:\s*\S[\s\S]*?\n---/.test(body)) {
      return json(res, 400, { error: 'Body must be a SKILL.md with YAML front-matter including a description' });
    }
    if (!updateSkillDraftBody(id, body)) return json(res, 404, { error: 'Draft not found' });
    return json(res, 200, { ok: true });
  }
  if (draftMatch && (method === 'GET' || method === 'DELETE')) {
    if (!isAnyAdmin(userId)) return json(res, 403, { error: 'Admin privilege required' });
    const id = decodeURIComponent(draftMatch[1]);
    const draft = getSkillDraft(id);
    if (!draft || draft.status !== 'pending') return json(res, 404, { error: 'Draft not found' });
    if (method === 'GET') {
      // For a patch, hand back the version it would REPLACE too, so the reviewer
      // sees what actually changes rather than a wall of unchanged text.
      let currentBody = '';
      if (draft.kind === 'patch' && draft.target_skill) {
        currentBody = readSkillBody(draft.agent_group_id, draft.target_skill);
      }
      return json(res, 200, {
        id: draft.id,
        skillName: draft.skill_name,
        description: draft.description,
        kind: draft.kind,
        targetSkill: draft.target_skill,
        agentGroupId: draft.agent_group_id,
        body: readSkillDraftBody(id) || '',
        currentBody,
      });
    }
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    if (!resolveSkillDraft(id, 'discarded')) return json(res, 404, { error: 'Draft not found' });
    resolveDraftCard(id, 'discarded', userId);
    return json(res, 200, { ok: true });
  }
  // Keep + wire a draft to an agent group (scoped, origin "learned").
  // Trial run (learning loop): mount the DRAFT into a fresh thread's session —
  // and only that session — so the skill can be judged by observed behavior
  // before Keep. The overlay lives at data/trial-skills/<group>/<thread>/ and
  // is cleaned up when the draft resolves.
  const draftTrialMatch = url.pathname.match(/^\/api\/skill-drafts\/([^/]+)\/trial$/);
  if (draftTrialMatch && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const draft = getSkillDraft(decodeURIComponent(draftTrialMatch[1]));
    if (!draft) return json(res, 404, { error: 'Draft not found' });
    if (!hasAdminPrivilege(userId, draft.agent_group_id)) return json(res, 403, { error: 'Admin privilege required' });
    return startSkillTrialHandler(res, draft);
  }
  const draftKeepMatch = url.pathname.match(/^\/api\/skill-drafts\/([^/]+)\/keep$/);
  if (draftKeepMatch && method === 'POST') {
    const id = decodeURIComponent(draftKeepMatch[1]);
    const draft = getSkillDraft(id);
    if (!draft || draft.status !== 'pending') return json(res, 404, { error: 'Draft not found' });
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    return keepSkillDraftHandler(req, res, userId, draft);
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

  // ── Sessions (list + reset) ────────────────────────────────────────────
  // Lets an admin reach an agent's sessions — including background a2a
  // sessions no room-typed /clear can target — and reset one (inject /clear).
  const agentSessionsMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/sessions$/);
  if (agentSessionsMatch && method === 'GET') {
    const group = resolveAgent(decodeURIComponent(agentSessionsMatch[1]));
    if (!group) return json(res, 404, { error: 'Agent not found' });
    if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
    const sessions = getSessionsByAgentGroup(group.id)
      .filter((s) => s.status === 'active')
      .map((s) => ({
        id: s.id,
        thread_id: s.thread_id,
        container_status: s.container_status,
        last_active: s.last_active,
      }));
    return json(res, 200, { sessions });
  }
  const sessionResetMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/reset$/);
  if (sessionResetMatch && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const session = getSession(decodeURIComponent(sessionResetMatch[1]));
    if (!session) return json(res, 404, { error: 'Session not found' });
    if (!hasAdminPrivilege(userId, session.agent_group_id)) {
      return json(res, 403, { error: 'Admin privilege required' });
    }
    try {
      injectSessionCommand(session.agent_group_id, session.id, '/clear');
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  // Bulk: inject a command (/clear or /compact) into every active session of
  // every agent wired to a room — the "/clear all" / "/compact all" fan-out.
  // Resolves the room's agents server-side, and only touches agents the caller
  // has admin over (incl. their background a2a sessions).
  const roomBroadcastMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/sessions\/broadcast$/);
  if (roomBroadcastMatch && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    const roomId = decodeURIComponent(roomBroadcastMatch[1]);
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let command = '';
    try {
      command = String((JSON.parse(raw) as { command?: unknown }).command || '');
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    if (!SESSION_COMMANDS.has(command)) return json(res, 400, { error: 'command must be /clear or /compact' });
    const agents = getAgentsForWebchatRoom(roomId).filter((a) => hasAdminPrivilege(userId, a.id));
    if (agents.length === 0) return json(res, 403, { error: 'Admin privilege required' });
    let count = 0;
    for (const a of agents) {
      for (const s of getSessionsByAgentGroup(a.id).filter((x) => x.status === 'active')) {
        try {
          injectSessionCommand(a.id, s.id, command);
          count++;
        } catch {
          /* skip sessions whose inbound.db is missing */
        }
      }
    }
    return json(res, 200, { ok: true, count });
  }

  // ── Models ────────────────────────────────────────────────────────────
  if (url.pathname === '/api/models' && method === 'GET') {
    return json(res, 200, listModelsForUI());
  }

  // ── Ollama host management (owner-only; SSRF-gated in ollama-manage) ──
  if (url.pathname === '/api/ollama/hosts' && method === 'GET') {
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    const hosts = new Set<string>();
    for (const m of listWebchatModels()) {
      if (m.kind === 'ollama' && m.endpoint) hosts.add(m.endpoint.replace(/\/+$/, ''));
    }
    try {
      const cfg = fs.readFileSync(path.join(process.cwd(), 'data/litellm/config.yaml'), 'utf8');
      for (const h of (parseConfiguredHosts(cfg) ?? '').split(',')) {
        if (h.trim()) hosts.add(h.trim().replace(/\/+$/, ''));
      }
    } catch {
      /* no litellm installed — models-derived hosts only */
    }
    return json(res, 200, { hosts: [...hosts].sort() });
  }
  if (url.pathname === '/api/ollama/models' && method === 'GET') {
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    const host = url.searchParams.get('host') || '';
    if (!host) return json(res, 400, { error: 'host required' });
    try {
      return json(res, 200, { models: await listHostModels(host) });
    } catch (err) {
      return json(res, 502, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (url.pathname === '/api/router/routes' && method === 'GET') {
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    const cfg = readRoutesConfig();
    if (!cfg) return json(res, 404, { error: 'Routing not installed' });
    const view = routerView(cfg, url.searchParams.get('router') ?? undefined);
    return json(res, 200, {
      routers: listRouters(cfg),
      router: view.name,
      routes: view.routes,
      default_route: view.default_route ?? null,
      live: cfg.live ?? null,
    });
  }
  if (url.pathname === '/api/router/routes' && method === 'PUT') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let update: RoutesUpdate;
    try {
      update = JSON.parse(raw) as RoutesUpdate;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    const cfg = readRoutesConfig();
    if (!cfg) return json(res, 404, { error: 'Routing not installed' });
    try {
      const target = url.searchParams.get('router') ?? undefined;
      const merged = mergeRoutesUpdate(cfg, update, target);
      writeRoutesConfig(merged);
      const view = routerView(merged, target);
      return json(res, 200, {
        ok: true,
        routers: listRouters(merged),
        router: view.name,
        routes: view.routes,
        default_route: view.default_route ?? null,
        live: merged.live ?? null,
      });
    } catch (err) {
      return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (url.pathname === '/api/router/routers' && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { name?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const cfg = readRoutesConfig();
    if (!cfg) return json(res, 404, { error: 'Routing not installed' });
    try {
      const next = addRouter(cfg, name); // clones the primary router as a starting point
      writeRoutesConfig(next);
      // Register the router as an openai-compatible model so agents can assign
      // it (the virtual model name = the router name, at the router endpoint).
      const endpoint = (await getRouterInfo()).endpoint;
      if (!listWebchatModels().some((m) => m.model_id === name && m.endpoint === endpoint)) {
        createWebchatModel({
          id: randomUUID(),
          name,
          kind: 'openai-compatible',
          endpoint,
          model_id: name,
          credential_ref: null,
          created_at: Date.now(),
        });
      }
      return json(res, 200, { ok: true, routers: listRouters(next), router: name });
    } catch (err) {
      return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  const routerDelMatch = url.pathname.match(/^\/api\/router\/routers\/([^/]+)$/);
  if (routerDelMatch && method === 'DELETE') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    const name = decodeURIComponent(routerDelMatch[1]);
    const cfg = readRoutesConfig();
    if (!cfg) return json(res, 404, { error: 'Routing not installed' });
    // Refuse while an agent is still assigned to this router's model.
    const model = listWebchatModels().find((m) => m.model_id === name);
    if (model) {
      const assigned = getAgentsAssignedToModel(model.id);
      if (assigned.length > 0) {
        return json(res, 409, {
          error: `router "${name}" is assigned to ${assigned.length} agent(s) — unassign first`,
        });
      }
    }
    try {
      const next = deleteRouter(cfg, name);
      writeRoutesConfig(next);
      if (model) deleteWebchatModel(model.id);
      return json(res, 200, { ok: true, routers: listRouters(next) });
    } catch (err) {
      return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (url.pathname === '/api/router/classify' && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { prompt?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    if (typeof body.prompt !== 'string' || !body.prompt.trim()) return json(res, 400, { error: 'prompt required' });
    try {
      return json(res, 200, await dryClassify(body.prompt.trim()));
    } catch (err) {
      return json(res, 502, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (url.pathname === '/api/router/decisions' && method === 'GET') {
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 20));
    return json(res, 200, { decisions: recentDecisions(limit) });
  }
  if (url.pathname === '/api/router/metrics' && method === 'GET') {
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    const days = Math.max(1, Math.min(30, Number(url.searchParams.get('days')) || 7));
    return json(res, 200, getRouterMetrics(days));
  }
  if (url.pathname === '/api/router/suggestions' && method === 'GET') {
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    return json(res, 200, { suggestions: await getRouteSuggestions() });
  }
  if (url.pathname === '/api/router/models' && method === 'GET') {
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    return json(res, 200, await getRouterInfo());
  }
  if (url.pathname === '/api/ollama/pulls' && method === 'GET') {
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    return json(res, 200, { pulls: getPullsSnapshot() });
  }
  // Wizard: hardware profile + a recommended local model to prefill the download.
  if (url.pathname === '/api/ollama/recommend' && method === 'GET') {
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    return json(res, 200, recommendForHost());
  }
  // Local Ollama for the wizard: status probe + one-click rootless install.
  if (url.pathname === '/api/ollama/local' && method === 'GET') {
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    return json(res, 200, await getOllamaLocalState());
  }
  if (url.pathname === '/api/ollama/install' && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    const result = startOllamaInstall();
    return json(res, result.started ? 200 : 409, result);
  }
  if (url.pathname === '/api/ollama/pull' && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { host?: unknown; model?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    if (typeof body.host !== 'string' || !body.host.trim()) return json(res, 400, { error: 'host required' });
    if (typeof body.model !== 'string' || !body.model.trim()) return json(res, 400, { error: 'model required' });
    try {
      const job = await startPull(body.host.trim(), body.model.trim());
      return json(res, 202, { pull: job });
    } catch (err) {
      return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (url.pathname === '/api/router/roster-refresh' && method === 'GET') {
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    return json(res, 200, getRosterRefreshState());
  }
  if (url.pathname === '/api/router/roster-refresh' && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    const started = startRosterRefresh();
    return json(res, started ? 202 : 409, { ...getRosterRefreshState(), started });
  }
  if (url.pathname === '/api/router/install' && method === 'GET') {
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    return json(res, 200, getRoutingInstallState());
  }
  if (url.pathname === '/api/router/install' && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    const r = startRoutingInstall();
    if (r.error === 'litellm-not-installed') {
      return json(res, 409, {
        error: 'LiteLLM is not installed. Run /add-litellm first.',
        code: 'litellm-not-installed',
      });
    }
    if (r.error === 'installer-missing') {
      return json(res, 409, {
        error: 'The add-routing skill is not present in this checkout.',
        code: 'installer-missing',
      });
    }
    return json(res, r.started ? 202 : 409, { ...getRoutingInstallState(), started: r.started });
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

  // Static PWA is served pre-auth (see the servePwa call above the auth gate).
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

// Text assets we compress before sending. Images (png/jpg/webp/ico) are already
// compressed — running them through gzip/brotli wastes CPU for ~0% gain.
const COMPRESSIBLE_EXT = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.md', '.webmanifest', '.map']);

// In-memory asset cache keyed by path → { raw, per-encoding compressed, etag }.
// Invalidated by (mtimeMs, size): a redeploy that rewrites the file re-reads +
// re-compresses on the next request; unchanged files serve from memory, so we
// stop hitting the disk and stop re-compressing the same 400KB bundle per load.
type CachedAsset = { mtimeMs: number; size: number; etag: string; raw: Buffer; gzip?: Buffer; br?: Buffer };
const assetCache = new Map<string, CachedAsset>();

function loadAsset(filePath: string): CachedAsset {
  const st = fs.statSync(filePath);
  const hit = assetCache.get(filePath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  const raw = fs.readFileSync(filePath);
  const etag = '"' + createHash('sha256').update(raw).digest('hex').slice(0, 16) + '"';
  const entry: CachedAsset = { mtimeMs: st.mtimeMs, size: st.size, etag, raw };
  assetCache.set(filePath, entry);
  return entry;
}

// Pick the best encoding the client accepts (brotli > gzip > identity), but only
// for compressible types. Compressed bytes are memoized on the cache entry so a
// given asset version is compressed at most once per encoding.
function encodedBody(entry: CachedAsset, accept: string, compressible: boolean): { body: Buffer; encoding?: string } {
  if (!compressible) return { body: entry.raw };
  if (/\bbr\b/.test(accept)) {
    entry.br ??= zlib.brotliCompressSync(entry.raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } });
    return { body: entry.br, encoding: 'br' };
  }
  if (/\bgzip\b/.test(accept)) {
    entry.gzip ??= zlib.gzipSync(entry.raw, { level: 6 });
    return { body: entry.gzip, encoding: 'gzip' };
  }
  return { body: entry.raw };
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
  const accept = (req.headers['accept-encoding'] as string) || '';
  const compressible = COMPRESSIBLE_EXT.has(ext);
  // sw.js carries a `__CACHE_VERSION__` placeholder; substitute the derived
  // asset hash so the service worker's cache name tracks asset content. Its body
  // is computed per request (infrequent), so compress inline without caching.
  if (basename === 'sw.js') {
    const raw = Buffer.from(
      fs.readFileSync(filePath, 'utf8').replace('__CACHE_VERSION__', computeSwCacheVersion(publicDir)),
    );
    const headers: Record<string, string> = { 'Content-Type': contentType, 'Cache-Control': 'no-cache' };
    let body = raw;
    if (/\bbr\b/.test(accept)) {
      body = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } });
      headers['Content-Encoding'] = 'br';
    } else if (/\bgzip\b/.test(accept)) {
      body = zlib.gzipSync(raw, { level: 6 });
      headers['Content-Encoding'] = 'gzip';
    }
    if (headers['Content-Encoding']) headers['Vary'] = 'Accept-Encoding';
    res.writeHead(200, headers);
    res.end(body);
    return true;
  }
  // `no-cache` = browser MAY cache but must revalidate before reuse — deliberate:
  // it stops browsers and reverse proxies (Azure App Service, Cloudflare, nginx)
  // holding stale CSS/JS/HTML across deploys. The content-hash ETag makes that
  // revalidation cheap: an unchanged asset gets a 304 (empty body) instead of
  // re-downloading. Freshness across deploys is owned by the SW cache version.
  const entry = loadAsset(filePath);
  if (req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, { ETag: entry.etag, 'Cache-Control': 'no-cache' });
    res.end();
    return true;
  }
  const { body, encoding } = encodedBody(entry, accept, compressible);
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
    ETag: entry.etag,
  };
  if (encoding) {
    headers['Content-Encoding'] = encoding;
    headers['Vary'] = 'Accept-Encoding';
  }
  res.writeHead(200, headers);
  res.end(body);
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
    const touched = new Set<string>([agentGroupId]);
    for (const peer of peers) {
      ensureA2aDestination(agentGroupId, peer.id, peer.folder);
      if (newAgent) ensureA2aDestination(peer.id, agentGroupId, newAgent.folder);
      touched.add(peer.id);
    }
    // Project the new destinations into every touched agent's RUNNING sessions
    // so co-resident agents can address each other immediately — without this
    // a peer whose container is already up sees the newcomer as "unknown:agent"
    // and gets "Unknown destination" trying to reply, until its next respawn.
    for (const id of touched) projectDestinationsToActiveSessions(id);
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
/**
 * Cap on the *fresh* sync (high-water mark = 0): bounds the first pull/push so it
 * can't dump an enormous backlog. Incremental syncs are naturally small (delta).
 */
const FRESH_SYNC_LIMIT = 50;

/** Live agent sessions for a destination thread key (null = the room's main
 * session). Existing sessions only — a thread with no session yet has no agent
 * memory to seed; the copied transcript is still visible in chat and the agent
 * picks it up when its session is first created through the normal inbound path. */
function sessionsForThreadKey(messagingGroupId: string, sessionKey: string | null): TeardownTarget[] {
  const rows = (
    sessionKey === null
      ? getDb()
          .prepare(`SELECT id, agent_group_id FROM sessions WHERE messaging_group_id = ? AND thread_id IS NULL`)
          .all(messagingGroupId)
      : getDb()
          .prepare(`SELECT id, agent_group_id FROM sessions WHERE messaging_group_id = ? AND thread_id = ?`)
          .all(messagingGroupId, sessionKey)
  ) as { id: string; agent_group_id: string }[];
  return rows.map((r) => ({ sessionId: r.id, agentGroupId: r.agent_group_id }));
}

/**
 * Copy the native message delta from one thread into another (verbatim, additive),
 * seed the destination thread's agent session(s) with it as silent context
 * (trigger=0 — never wakes a turn), broadcast the copies to connected clients, and
 * advance the per-thread high-water mark so repeat syncs only carry genuinely new
 * messages. `markThreadId` is always the topic thread the (main, topic) pair is
 * keyed under — both directions track progress against that one row so a push and
 * a pull on the same thread don't share a mark. Returns the number of messages
 * copied (excluding the divider; 0 = nothing new). See
 * docs/webchat/thread-context-sync.md.
 */
export function syncThreadContext(opts: {
  roomId: string;
  srcThreadId: string;
  destThreadId: string;
  markThreadId: string;
  direction: 'pulled' | 'pushed';
  dividerText: string;
  freshLimit?: number;
}): number {
  const { roomId, srcThreadId, destThreadId, markThreadId, direction, dividerText, freshLimit = 0 } = opts;
  const marks = getThreadSyncMarks(roomId, markThreadId);
  const sinceTs = direction === 'pulled' ? marks.pulled : marks.pushed;
  const delta = getSyncDelta(roomId, srcThreadId, sinceTs, sinceTs === 0 ? freshLimit : 0);
  if (delta.length === 0) return 0;

  const inserted = insertSyncedMessages(roomId, destThreadId, delta, direction, dividerText);

  // Advance the high-water mark to the newest source row carried, so a repeat
  // sync only picks up messages added after this batch (setThreadSyncMark is
  // monotonic, so a concurrent larger mark never moves backwards).
  const maxSrcTs = delta.reduce((mx, m) => Math.max(mx, m.created_at), sinceTs);
  setThreadSyncMark(roomId, markThreadId, direction, maxSrcTs);

  // Broadcast the copies (divider + messages) so the destination thread updates live.
  for (const row of inserted) {
    broadcast(roomId, { type: 'message', ...row });
  }

  // Seed the destination thread's agent session(s) with the copied transcript as
  // silent context. Content matches the webchat inbound shape so the agent-runner
  // formats it identically to a real message.
  const copies = inserted.filter((m) => m.message_type !== 'context-divider');
  const mg = getMessagingGroupByPlatform('webchat', roomId);
  if (mg) {
    const destKey = threadToSessionKey(destThreadId);
    for (const s of sessionsForThreadKey(mg.id, destKey)) {
      const ctx: ContextMessage[] = copies.map((m) => ({
        id: `ctx-${direction}-${s.sessionId}-${m.id}`,
        kind: 'chat',
        timestamp: new Date(m.created_at).toISOString(),
        platformId: roomId,
        channelType: 'webchat',
        threadId: destKey,
        content: JSON.stringify({ text: m.content, sender: m.sender, senderName: m.sender, senderId: '' }),
        trigger: 0,
      }));
      syncSessionContext(s.agentGroupId, s.sessionId, ctx);
    }
  }
  return copies.length;
}

/** Engaged agents in a thread, resolved to {id, name, folder} for the UI. */
function engagedAgentsForThread(roomId: string, threadId: string): Array<{ id: string; name: string; folder: string }> {
  const ids = new Set(getEngagedAgents(roomId, threadId));
  if (ids.size === 0) return [];
  return getAgentsForWebchatRoom(roomId)
    .filter((a) => ids.has(a.id))
    .map((a) => ({ id: a.id, name: a.name, folder: a.folder }));
}

/** Push the current engaged set for a thread to all room clients (live chips). */
function broadcastEngagedSet(roomId: string, threadId: string): void {
  broadcast(roomId, {
    type: 'engaged_set_changed',
    room_id: roomId,
    thread_id: threadId,
    engaged: engagedAgentsForThread(roomId, threadId),
  });
}

const ENGAGE_FOLDER_ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

/**
 * Engaged-thread routing decision for the host router (registered via
 * setEngagedResolver). Auto-engages @mentioned wired agents, then classifies each
 * engaged agent as 'expected' (addressed, or the sole engaged agent on an
 * un-addressed message → a one-agent thread keeps replying without re-mention) or
 * 'defer' (engaged but someone else was addressed → receives context, no reply).
 * Returns null when engagement doesn't apply so the router falls back to normal
 * mention-only routing. See docs/webchat/thread-engaged-agents.md.
 */
export function resolveEngagedDecision(
  mg: MessagingGroup,
  threadId: string | null,
  messageText: string,
  senderAgentGroupId: string | undefined,
): EngagedDecision | null {
  if (mg.channel_type !== 'webchat') return null;
  if (threadId === null || threadId === 'main') return null;
  const roomId = mg.platform_id;
  const wired = getAgentsForWebchatRoom(roomId);
  if (wired.length === 0) return null;
  const wiredIds = new Set(wired.map((a) => a.id));

  // Peer fan-out: an engaged agent's own reply is delivered to the OTHER engaged
  // agents as silent context (isPeerReply, trigger=0) so they stay in sync but
  // never reply to a peer (no cascades). The producer is excluded.
  if (senderAgentGroupId) {
    const allEngaged = [...getEngagedAgents(roomId, threadId)].filter((id) => wiredIds.has(id));
    const recipients = allEngaged.filter((id) => id !== senderAgentGroupId);
    if (recipients.length === 0) return null;
    const perAgent = new Map<string, 'expected' | 'defer'>();
    for (const id of recipients) perAgent.set(id, 'defer');
    return { engaged: allEngaged, perAgent, isPeerReply: true };
  }

  // Which wired agents are explicitly @mentioned (case-insensitive, word-boundary).
  const mentioned = new Set<string>();
  for (const a of wired) {
    const re = new RegExp(`\\B@${a.folder.replace(ENGAGE_FOLDER_ESCAPE_RE, '\\$&')}\\b`, 'i');
    if (re.test(messageText)) mentioned.add(a.id);
  }

  // Auto-engage any newly-mentioned wired agent (broadcast the chip change once).
  const engaged = new Set([...getEngagedAgents(roomId, threadId)].filter((id) => wiredIds.has(id)));
  let changed = false;
  for (const id of mentioned) {
    if (!engaged.has(id)) {
      engageAgent(roomId, threadId, id);
      engaged.add(id);
      changed = true;
    }
  }
  if (changed) broadcastEngagedSet(roomId, threadId);
  if (engaged.size === 0) return null; // nothing engaged → normal mention-only routing

  const soleEngaged = engaged.size === 1;
  const perAgent = new Map<string, 'expected' | 'defer'>();
  for (const id of engaged) {
    const addressed = mentioned.has(id) || (mentioned.size === 0 && soleEngaged);
    perAgent.set(id, addressed ? 'expected' : 'defer');
  }
  return { engaged: [...engaged], perAgent };
}

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
    // No prime — un-primed agents reply only when explicitly @-mentioned. The
    // legacy 'broadcast' fallback (every agent answers every message) has been
    // retired; a shared room stays quiet until an agent is addressed.
    for (const w of wirings) update.run(`\\B@${ciFolderToken(w.folder)}\\b`, w.id);
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
  /**
   * When no webchat model is assigned, a label derived from the agent's actual
   * runtime provider (container_configs.provider), so the PWA can show what the
   * agent really runs on instead of defaulting to "Built-in Anthropic". null
   * when a model IS assigned (the PWA shows that model) or the provider is the
   * built-in Claude path (the PWA shows its Anthropic default).
   */
  effective_model_label: string | null;
}

/**
 * Derive a display label for an agent with NO assigned webchat model, from its
 * runtime provider. Returns null for the built-in Claude path (caller shows the
 * Anthropic default). Best-effort: the specific model is read from the agent's
 * settings.json env stub when present (webchat's own openai-compatible
 * assignment writes OPENAI_MODEL there); an install-wide `.env` OPENCODE_MODEL
 * isn't per-agent so it's not surfaced here — the provider alone is accurate.
 */
function deriveEffectiveModelLabel(agentGroupId: string): string | null {
  const provider = getContainerConfig(agentGroupId)?.provider ?? 'claude';
  if (provider === 'opencode') {
    let model: string | undefined;
    try {
      const p = path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.claude-shared', 'settings.json');
      const env = (JSON.parse(fs.readFileSync(p, 'utf-8')).env ?? {}) as Record<string, string>;
      model = env.OPENAI_MODEL || env.OPENCODE_MODEL;
    } catch {
      // no per-agent stub — fall through to the install-wide default
    }
    // Install-wide fallback: this host keeps .env out of process.env, so read
    // the file. Not per-agent, but for an install-wide opencode setup it's the
    // model every such agent runs on.
    if (!model) model = readEnvFile(['OPENCODE_MODEL']).OPENCODE_MODEL;
    // Strip a leading "<provider>/" (e.g. "openai/llama3.2:3b" → "llama3.2:3b").
    if (model) model = model.replace(/^[^/]+\//, '');
    return model || 'OpenCode';
  }
  if (provider === 'codex') return 'Codex';
  // Claude family with no assignment: the group may still run on the WORKSPACE
  // DEFAULT model (the wizard's Ollama engine). Label it honestly — showing
  // "anthropic" for an agent that answers via Ollama misleads the operator.
  const effective = getEffectiveModelForAgent(agentGroupId);
  if (effective) return `${effective.model_id} (workspace default)`;
  return null;
}

function toAgentForUI(g: AgentGroup): AgentForUI {
  // Convention: createAgentHandler uses `group.folder` as the webchat_room id when it
  // creates a room alongside the agent. Look that up directly so the PWA
  // doesn't have to guess.
  const room = getWebchatRoom(g.folder);
  const assigned = getAssignedModelForAgent(g.id);
  return {
    ...g,
    room_id: room ? room.id : null,
    assigned_model_id: assigned ? assigned.id : null,
    effective_model_label: assigned ? null : deriveEffectiveModelLabel(g.id),
  };
}

// Inject an admin command (/clear or /compact) into a session's inbound.db —
// exactly what a room-typed command does, but reachable for background a2a
// sessions. The poll-loop processes these before any query, so /clear drops the
// poisoned continuation before the next turn. The host owns inbound.db (single
// writer). Bulk broadcast ("… all") loops this over every active session.
const SESSION_COMMANDS = new Set(['/clear', '/compact']);
function injectSessionCommand(agentGroupId: string, sessionId: string, command: string): void {
  if (!SESSION_COMMANDS.has(command)) throw new Error(`unsupported session command: ${command}`);
  const dbPath = path.join(DATA_DIR, 'v2-sessions', agentGroupId, sessionId, 'inbound.db');
  if (!fs.existsSync(dbPath)) throw new Error('session inbound.db not found');
  const db = openInboundDb(dbPath);
  try {
    insertMessage(db, {
      id: `${randomUUID()}:${agentGroupId}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: 'webchat',
      channelType: 'webchat',
      threadId: null,
      content: JSON.stringify({
        text: command,
        sender: 'operator',
        senderId: 'webchat:operator',
        senderName: 'operator',
      }),
      processAfter: null,
      recurrence: null,
      trigger: 1,
    });
  } finally {
    db.close();
  }
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
type AgentRef =
  | { kind: 'existing'; id: string }
  | { kind: 'new'; name: string; instructions?: string; provider?: 'codex' };

function parseAgentRef(raw: unknown): AgentRef | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'Invalid agent reference' };
  const r = raw as { kind?: unknown; id?: unknown; name?: unknown; instructions?: unknown; provider?: unknown };
  if (r.kind === 'existing') {
    if (typeof r.id !== 'string' || !r.id.trim()) return { error: 'agent.id required for kind=existing' };
    return { kind: 'existing', id: r.id.trim() };
  }
  if (r.kind === 'new') {
    if (typeof r.name !== 'string' || !r.name.trim()) return { error: 'agent.name required for kind=new' };
    // Optional non-default provider for the new agent (wizard "default engine"
    // = Codex). Only 'codex' is accepted — 'claude' is the implicit default,
    // and opencode groups are wired by their own installer, not room-create.
    if (r.provider !== undefined) {
      if (r.provider !== 'codex') return { error: "agent.provider must be 'codex' when set" };
      if (!codexAvailable()) return { error: 'Codex support isn’t installed yet — add it with /add-codex first.' };
    }
    return {
      kind: 'new',
      name: r.name.trim(),
      instructions: typeof r.instructions === 'string' ? r.instructions : undefined,
      provider: r.provider as 'codex' | undefined,
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
  // Materialize the model env NOW: a group born AFTER the workspace default
  // model was set would otherwise have no settings.json until some later
  // model change — its first container would fall through to api.anthropic.com
  // (surfaced as a OneCLI 401 in the wizard's Ollama flow, where the default
  // is set one step before the first agent is created).
  try {
    writeAgentSettingsForAssignedModel(group.id);
  } catch (err) {
    log.warn('Webchat: settings.json write for new agent group failed', { agentGroupId: group.id, err });
  }
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
    // Non-default provider (validated in parseAgentRef): pin it on the group's
    // container config so the first spawn already runs the right harness.
    if (ref.provider) {
      ensureContainerConfig(result.group.id);
      updateContainerConfigScalars(result.group.id, { provider: ref.provider });
    }
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

/** Delete a thread: drop its registry row + messages + read markers, and tear
 * down its per-thread session (DB state in the txn; container/dir after commit).
 * The room and other threads are untouched. */
function deleteThreadHandler(res: ServerResponse, roomId: string, threadId: string): void {
  const mg = getMessagingGroupByPlatform('webchat', roomId);
  // The session for a named thread is keyed by thread_id = threadId.
  const sessions: TeardownTarget[] = mg ? findSessionsByMessagingGroupThread(mg.id, threadId) : [];
  try {
    getDb().transaction(() => {
      for (const s of sessions) deleteSessionDbState(s.sessionId);
      deleteWebchatThread(roomId, threadId);
    })();
  } catch (err) {
    log.error('Webchat: deleteThreadHandler failed', { roomId, threadId, err });
    return json(res, 500, { error: 'Failed to delete thread' });
  }
  // Side-effects after commit (can't roll back): kill containers + remove dirs.
  void teardownSessionResources(sessions, 'webchat thread deleted');
  broadcastRooms(); // refresh each client's sidebar thread-count chevron
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
  /** Named assignees so the detail panel can say WHO, not just how many. */
  agents: Array<{ id: string; name: string }>;
  /**
   * Rooms this model reaches transitively — the union of rooms wired to any
   * agent it's assigned to — so the detail panel can link straight to them.
   */
  rooms: Array<{ id: string; name: string }>;
}

function listModelsForUI(): ModelForUI[] {
  return listWebchatModels().map((m) => {
    const ids = getAgentsAssignedToModel(m.id);
    const roomMap = new Map<string, { id: string; name: string }>();
    for (const id of ids) {
      for (const r of getWebchatRoomsForAgent(id)) roomMap.set(r.id, { id: r.id, name: r.name });
    }
    return {
      ...m,
      agents_assigned: ids.length,
      agents: ids.map((id) => ({ id, name: getAgentGroup(id)?.name ?? id })),
      rooms: [...roomMap.values()],
    };
  });
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
  // If this model was the workspace default, clear it and refresh the groups
  // that were inheriting it (they fall back to the workspace credential).
  if (getDefaultModelId() === id) {
    setDefaultModelId(null);
    refreshUnassignedGroupsForDefaultModel('Workspace default model deleted');
  }
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
    const model = getWebchatModel(body.modelId.trim());
    if (!model) return json(res, 404, { error: 'Model not found' });
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
    // Provider follows the assigned model's kind (openai-compatible ->
    // opencode, everything else -> default). Same next-spawn timing as the
    // env write; the restart below applies both.
    syncAgentProviderForAssignedModel(agentGroupId);
  } catch (err) {
    log.warn('Webchat: provider sync after model change failed', { agentGroupId, reason, err });
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

/**
 * Respawn containers after a workspace-default credential MODE change (key ↔
 * subscription, or removing an OAuth default). The Claude OAuth sentinel env and
 * the Codex gateway auth stub are applied at container SPAWN, so a running
 * container would keep the wrong auth mode until it idles out. Scoped to the
 * groups the provider actually serves: `claude` → every non-Codex group;
 * `codex` → Codex groups only. Value-only rotation (same mode) needs no restart —
 * OneCLI swaps the real credential on the wire per request.
 */
function restartGroupsForWorkspaceCredChange(
  provider: 'claude' | 'codex',
  priorOauth: boolean,
  nowOauth: boolean,
): void {
  if (priorOauth === nowOauth) return;
  for (const g of getAllAgentGroups()) {
    const groupProvider = getContainerConfig(g.id)?.provider === 'codex' ? 'codex' : 'claude';
    if (groupProvider !== provider) continue;
    try {
      restartAgentGroupContainers(g.id, 'Workspace default credential mode changed');
    } catch (err) {
      log.warn('Webchat: container restart after workspace-cred change failed', { agentGroupId: g.id, err });
    }
  }
}

/**
 * Aftermath of SETTING a workspace-default credential (the wizard's engine
 * choice). Choosing Claude/Codex supersedes a leftover Ollama workspace-default
 * MODEL — which otherwise still wins for base agents (getEffectiveModelForAgent
 * returns the default model regardless of credential), so connecting Claude
 * would silently keep agents on the local model. Clear the default model, then
 * respawn the affected groups (the respawn also applies the OAuth sentinel).
 */
function afterWorkspaceCredentialSet(provider: 'claude' | 'codex', priorOauth: boolean, nowOauth: boolean): void {
  // The default model is always an ollama-kind (claude-family) model, so it only
  // conflicts with a claude engine — a codex credential leaves it untouched.
  const clearModel = provider === 'claude' && getDefaultModelId() !== null;
  if (clearModel) {
    setDefaultModelId(null);
    // Rewrites settings.json (drops the ollama env) + respawns unassigned
    // claude-family groups; the respawn also picks up the new OAuth sentinel.
    refreshUnassignedGroupsForDefaultModel(`Workspace engine set to ${provider}`);
  } else {
    restartGroupsForWorkspaceCredChange(provider, priorOauth, nowOauth);
  }
}

/**
 * Re-materialize settings.json + respawn for every claude-family group WITHOUT
 * its own model assignment — the population the workspace default model serves.
 * Assigned groups are untouched (their assignment wins), as are codex/opencode
 * groups (their harness ignores the ANTHROPIC_* env this writes).
 */
function refreshUnassignedGroupsForDefaultModel(reason: string): void {
  for (const g of getAllAgentGroups()) {
    if (getAssignedModelForAgent(g.id)) continue;
    const provider = getContainerConfig(g.id)?.provider;
    if (provider && provider !== 'claude') continue;
    try {
      writeAgentSettingsForAssignedModel(g.id);
    } catch (err) {
      log.warn('Webchat: settings.json write for default-model change failed', { agentGroupId: g.id, reason, err });
    }
    try {
      restartAgentGroupContainers(g.id, reason);
    } catch (err) {
      log.warn('Webchat: container restart for default-model change failed', { agentGroupId: g.id, reason, err });
    }
  }
}

/** Restart a group's containers so an mcp_servers change is picked up at spawn. */
function reloadAgentMcpServers(agentGroupId: string): void {
  try {
    const restarted = restartAgentGroupContainers(agentGroupId, 'Webchat MCP servers changed');
    if (restarted > 0) log.info('Webchat: restarted containers after MCP change', { agentGroupId, restarted });
  } catch (err) {
    log.warn('Webchat: container restart after MCP change failed', { agentGroupId, err });
  }
}

// ── MCP server registry handlers ──
//
// The registry mirrors the models registry: owner-gated CRUD + probe, with a
// per-agent assignment surface. Secrets discipline: env/headers are accepted
// on create/update but NEVER returned by any list/read response.

interface McpServerForUI {
  id: string;
  name: string;
  transport: WebchatMcpTransport;
  /** Endpoint summary — url (remote) or command (stdio). Never env/headers. */
  target: string;
  agents_assigned: number;
  health: Record<string, unknown> | null;
  drift: Record<string, unknown> | null;
  pinned_tools: { name: string; description: string }[] | null;
  enabled_tools: string[] | null;
  /** Presence + kind only — the credential never leaves the host. */
  auth: { kind: string } | null;
}

function mcpServerForUI(s: WebchatMcpServer): McpServerForUI {
  const parse = (v: string | null) => {
    try {
      return v ? (JSON.parse(v) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const pinned = parse(s.pinned_tools) as { tools?: { name: string; description: string }[] } | null;
  return {
    id: s.id,
    name: s.name,
    transport: s.transport,
    target: (s.transport === 'stdio' ? s.command : s.url) ?? '',
    agents_assigned: getAgentsAssignedToMcpServer(s.id).length,
    health: parse(s.health),
    drift: parse(s.drift),
    pinned_tools: pinned?.tools ?? null,
    enabled_tools: (parse(s.enabled_tools) as unknown as string[] | null) ?? null,
    // Presence only — the credential itself never leaves the host.
    auth: (() => {
      const a = parseMcpAuth(s);
      return a ? { kind: a.kind } : null;
    })(),
  };
}

function listMcpServersForUI(): McpServerForUI[] {
  return listWebchatMcpServers().map(mcpServerForUI);
}

/** Parse + validate a registry create/update body into a WebchatMcpServerInput. */
function parseMcpServerBody(body: Record<string, unknown>): WebchatMcpServerInput {
  const name = validateMcpServerName(body.name);
  const transport = body.transport;
  if (transport !== 'stdio' && transport !== 'sse' && transport !== 'http') {
    throw new Error('transport must be "stdio" | "sse" | "http"');
  }
  const input: WebchatMcpServerInput = { name, transport };
  if (transport === 'stdio') {
    if (typeof body.command !== 'string' || !body.command.trim()) throw new Error('command required for stdio');
    input.command = body.command.trim();
    if (Array.isArray(body.args)) input.args = body.args.map(String);
    if (body.env && typeof body.env === 'object') input.env = body.env as Record<string, string>;
  } else {
    if (typeof body.url !== 'string' || !body.url.trim()) throw new Error('url required for a remote server');
    input.url = body.url.trim().replace(/\/+$/, '');
    if (body.headers && typeof body.headers === 'object') input.headers = body.headers as Record<string, string>;
  }
  if (typeof body.instructions === 'string' && body.instructions.trim()) input.instructions = body.instructions.trim();
  return input;
}

async function createMcpServerHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  let input: WebchatMcpServerInput;
  try {
    input = parseMcpServerBody(body);
  } catch (err) {
    return json(res, 400, { error: err instanceof Error ? err.message : 'Invalid MCP server' });
  }
  // Names key container_configs.mcp_servers (and the SDK's mcp__<name>__* tool
  // prefixes), so they must be unique across the registry.
  if (getWebchatMcpServerByName(input.name)) {
    return json(res, 409, { error: `An MCP server named "${input.name}" already exists` });
  }
  const server = createWebchatMcpServer(input);
  // The add form probes before saving — that probed surface is the operator's
  // approval, so pin it as the drift baseline right here.
  if (Array.isArray(body.tools) && body.tools.length) {
    try {
      pinMcpToolSurface(
        server.id,
        (body.tools as { name?: unknown; description?: unknown }[])
          .filter((t) => typeof t?.name === 'string')
          .map((t) => ({ name: String(t.name), description: String(t.description ?? '') })),
      );
    } catch {
      /* pin is protection, not a gate */
    }
  }
  return json(res, 200, { ok: true, server: mcpServerForUI(server) });
}

async function updateMcpServerHandler(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const existing = getWebchatMcpServer(id);
  if (!existing) return json(res, 404, { error: 'MCP server not found' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  let input: WebchatMcpServerInput;
  try {
    // Merge onto the existing row so a partial body (e.g. rename only) works.
    input = parseMcpServerBody({
      name: body.name ?? existing.name,
      transport: body.transport ?? existing.transport,
      command: body.command ?? existing.command ?? undefined,
      args: body.args ?? (existing.args ? JSON.parse(existing.args) : undefined),
      env: body.env ?? (existing.env ? JSON.parse(existing.env) : undefined),
      url: body.url ?? existing.url ?? undefined,
      headers: body.headers ?? (existing.headers ? JSON.parse(existing.headers) : undefined),
      instructions: body.instructions ?? existing.instructions ?? undefined,
    });
  } catch (err) {
    return json(res, 400, { error: err instanceof Error ? err.message : 'Invalid MCP server' });
  }
  const clash = getWebchatMcpServerByName(input.name);
  if (clash && clash.id !== id) {
    return json(res, 409, { error: `An MCP server named "${input.name}" already exists` });
  }
  const oldName = existing.name;
  updateWebchatMcpServer(id, input);
  // Re-sync every assigned agent: drop the old key when renamed, upsert the
  // new config, and restart so live containers pick the change up.
  const updated = getWebchatMcpServer(id);
  for (const agentGroupId of getAgentsAssignedToMcpServer(id)) {
    if (updated && oldName !== updated.name) syncAgentMcpConfig(agentGroupId, { ...updated, name: oldName }, false);
    if (updated) syncAgentMcpConfig(agentGroupId, updated, true);
    reloadAgentMcpServers(agentGroupId);
  }
  return json(res, 200, { ok: true });
}

function deleteMcpServerHandler(res: ServerResponse, id: string, force: boolean): void {
  const existing = getWebchatMcpServer(id);
  if (!existing) return json(res, 404, { error: 'MCP server not found' });
  const assigned = getAgentsAssignedToMcpServer(id);
  if (assigned.length > 0 && !force) {
    // Cascade-with-confirmation (mirrors models): surface the impact list so
    // the PWA can prompt before detaching the server from live agents.
    return json(res, 409, {
      error: 'MCP server is attached to agents. Re-request with ?force=1 to detach and delete.',
      assigned_agent_group_ids: assigned,
    });
  }
  for (const agentGroupId of assigned) {
    syncAgentMcpConfig(agentGroupId, existing, false);
  }
  deleteWebchatMcpServer(id);
  for (const agentGroupId of assigned) {
    reloadAgentMcpServers(agentGroupId);
  }
  return json(res, 200, { ok: true, unassigned_count: assigned.length });
}

/**
 * MCP catalog — the official Model Context Protocol registry.
 *
 * Read-only discovery. It NEVER writes: a row just prefills the existing add form,
 * so every server still goes through probe → create, and the catalog adds no new
 * write path to the MCP config.
 *
 * Two classes of entry, and the difference is the whole security story:
 *
 *   remote  — {type, url}. The container dials OUT to a hosted server. No foreign
 *             code runs on this machine.
 *   package — an npm/pypi package run over stdio. Adding one EXECUTES third-party
 *             code inside the agent container, alongside its credentials. Flagged
 *             `runsCode` so the UI can gate it behind an explicit confirm.
 *
 * Trust: there is no "official" tier here. Nothing in the registry is published by
 * Anthropic — and a name match would be actively dangerous, because third parties
 * publish servers *called* things like `anthropic-admin-mcp`. The badge shows the
 * real publisher namespace (the part before the '/') and nothing more.
 */
const MCP_REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers';
/**
 * The registry is a code-wired built-in source, exactly like the skills
 * marketplace — so it switches off the same way, through webchat_disabled_sources.
 * Same id space, same helpers, no new table.
 */
const MCP_REGISTRY_ID = 'mcp-registry';
const MCP_REGISTRY_SOURCE = {
  id: MCP_REGISTRY_ID,
  name: 'Model Context Protocol registry',
  url: 'https://registry.modelcontextprotocol.io',
  official: false, // community-published; nobody vets these
};

interface McpCatalogRow {
  name: string;
  title: string;
  description: string;
  version: string;
  publisher: string;
  kind: 'remote' | 'package';
  runsCode: boolean;
  url?: string;
  transport?: 'http' | 'sse';
  command?: string;
  args?: string[];
  /** Where the operator can go to actually READ this thing before trusting it. */
  repoUrl?: string;
  websiteUrl?: string;
}

const mcpCatalogCache = new Map<string, { at: number; rows: McpCatalogRow[] }>();
const MCP_CATALOG_TTL_MS = 5 * 60_000;

/** Compare dotted versions numerically so 1.10.0 beats 1.9.0 (string sort doesn't). */
function versionGreater(a: string, b: string): boolean {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** How a package identifier becomes a runnable stdio command. */
function packageCommand(
  registryType: string,
  identifier: string,
  version?: string,
): { command: string; args: string[] } | null {
  // Pin to the registry entry's immutable version — an unpinned `npx -y pkg`
  // re-resolves LATEST at every container spawn, which is exactly the
  // trusted-package-turns-malicious window (the postmark-mcp pattern). Only
  // pin when the string looks like a real version; the registry accepts any
  // ≤255-char string and a junk pin would break the install loudly.
  const pin = version && /^\d+\.\d+/.test(version) ? version : null;
  if (registryType === 'npm') return { command: 'npx', args: ['-y', pin ? `${identifier}@${pin}` : identifier] };
  if (registryType === 'pypi') return { command: 'uvx', args: [pin ? `${identifier}==${pin}` : identifier] };
  return null; // oci/other — we don't synthesize a command we can't vouch for
}

/** Third-party strings end up in an <a href> — allow http(s) only, nothing else. */
export function safeHttpUrl(u: unknown): string | undefined {
  if (typeof u !== 'string' || !u) return undefined;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeMcpRegistry(payload: unknown): McpCatalogRow[] {
  const servers = (payload as { servers?: { server?: Record<string, unknown> }[] })?.servers || [];
  const byName = new Map<string, McpCatalogRow>();
  for (const entry of servers) {
    const s = entry?.server;
    if (!s || typeof s.name !== 'string') continue;
    const name = s.name;
    const version = String(s.version || '0');
    const prev = byName.get(name);
    // The registry lists every published version — keep only the newest.
    if (prev && !versionGreater(version, prev.version)) continue;

    const remotes = (s.remotes as { type?: string; url?: string }[] | undefined) || [];
    const packages =
      (s.packages as { registryType?: string; identifier?: string }[] | undefined) || [];

    const repo = s.repository as { url?: string } | undefined;
    const base = {
      name,
      title: String(s.title || name.split('/').pop() || name),
      description: String(s.description || ''),
      version,
      publisher: name.includes('/') ? name.split('/')[0] : '',
      // Only ever surface http(s) links — a registry entry is third-party data, and
      // it must not be able to inject a javascript:/data: URL into an <a href>.
      repoUrl: safeHttpUrl(repo?.url),
      websiteUrl: safeHttpUrl(s.websiteUrl),
    };

    // Prefer the remote form when a server offers both — it's the safe one.
    const remote = remotes.find((r) => r.url);
    if (remote?.url) {
      byName.set(name, {
        ...base,
        kind: 'remote',
        runsCode: false,
        url: remote.url,
        // The registry says streamable-http / sse; our config takes http | sse.
        transport: remote.type === 'sse' ? 'sse' : 'http',
      });
      continue;
    }
    const pkg = packages.find((p) => p.identifier && p.registryType);
    if (pkg) {
      const cmd = packageCommand(String(pkg.registryType), String(pkg.identifier), version);
      if (!cmd) continue;
      byName.set(name, { ...base, kind: 'package', runsCode: true, command: cmd.command, args: cmd.args });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function mcpCatalogHandler(res: ServerResponse, q: string): Promise<void> {
  // Switched off in Settings → the catalog is gone, server-side too. Not just
  // hidden in the UI: no request is made to the registry at all.
  if (isSourceDisabled(MCP_REGISTRY_ID)) return json(res, 200, { servers: [], disabled: true });
  const key = q.trim().toLowerCase();
  const hit = mcpCatalogCache.get(key);
  if (hit && Date.now() - hit.at < MCP_CATALOG_TTL_MS) return json(res, 200, { servers: hit.rows });
  try {
    const target = `${MCP_REGISTRY_URL}?limit=100${key ? `&search=${encodeURIComponent(key)}` : ''}`;
    const r = await fetch(target, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return json(res, 502, { error: `Registry returned ${r.status}` });
    const rows = normalizeMcpRegistry(await r.json());
    mcpCatalogCache.set(key, { at: Date.now(), rows });
    return json(res, 200, { servers: rows });
  } catch (err) {
    return json(res, 502, { error: 'Registry unreachable: ' + (err instanceof Error ? err.message : String(err)) });
  }
}

async function probeMcpServerHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { url?: unknown; headers?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (typeof body.url !== 'string' || !body.url.trim()) return json(res, 400, { error: 'url required' });
  const url = body.url.trim();
  if (/\s|[<>]/.test(url)) return json(res, 400, { error: 'url contains invalid characters' });
  // Bare hosts are common ("winbox:8000") — default the scheme to http, the
  // typical case for a LAN/tailnet tool server (https rides through as-is).
  const withScheme = /^https?:\/\//i.test(url) ? url : `http://${url}`;
  const headers = body.headers && typeof body.headers === 'object' ? (body.headers as Record<string, string>) : {};
  try {
    const result = await probeMcpEndpoint(withScheme, headers);
    return json(res, 200, result);
  } catch (err) {
    // assertSafeOutboundUrl rejections land here — a 400, not a 500: the
    // input was refused, the probe itself didn't break.
    return json(res, 400, { error: err instanceof Error ? err.message : 'Probe failed' });
  }
}

// Available skills = folders containing a SKILL.md across BOTH mounts: the
// shipped container/skills and the runtime data/user-skills (imported/uploaded).
// The dir name is the id used in the config + symlinks; the front-matter
// `description` is shown in the picker. Shipped wins on a name collision.
const USER_SKILLS_DIR = path.join(process.cwd(), 'data', 'user-skills');

// Provenance recorded at import time in a `.origin.json` sidecar inside the
// skill folder, so the installed list can show where each skill came from
// ("Anthropic", "obra/superpowers", "awesomeskill.ai", …) long after import.
// A sidecar (not front-matter) keeps it out of the agent-facing SKILL.md and
// self-cleans when the skill folder is deleted.
type SkillOriginRef = { owner: string; repo: string; branch: string; dir: string };
type SkillOrigin = {
  label: string;
  url?: string;
  official?: boolean;
  /** Commit SHA the import was taken at — the pin that makes updates checkable. */
  sha?: string;
  /** Where to re-fetch from for update checks / re-imports. */
  ref?: SkillOriginRef;
};
function sanitizeOrigin(input: unknown): SkillOrigin | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const label = String(o.label ?? '')
    .trim()
    .slice(0, 60);
  if (!label) return null;
  const u = String(o.url ?? '').trim();
  const url = /^https:\/\/\S+$/i.test(u) && u.length <= 300 ? u : undefined;
  const out: SkillOrigin = { label, url, official: !!o.official };
  if (typeof o.sha === 'string' && /^[0-9a-f]{7,40}$/i.test(o.sha)) out.sha = o.sha;
  const r = o.ref as Record<string, unknown> | undefined;
  if (r && typeof r === 'object') {
    const part = (v: unknown) => String(v ?? '').slice(0, 200);
    const ref = { owner: part(r.owner), repo: part(r.repo), branch: part(r.branch), dir: part(r.dir) };
    if (ref.owner && ref.repo && ref.branch && /^[\w.-]+$/.test(ref.owner) && /^[\w.-]+$/.test(ref.repo)) {
      out.ref = ref;
    }
  }
  return out;
}

/**
 * Latest commit SHA touching a path — the freshness probe for update checks
 * and the pin recorded at import. Best-effort: null on any failure (an import
 * must never fail because a SHA lookup did). Cached like the catalogs.
 */
const shaCache = new Map<string, { at: number; sha: string | null }>();
async function latestCommitSha(ref: SkillOriginRef, maxAgeMs = 3600_000): Promise<string | null> {
  const key = `${ref.owner}/${ref.repo}@${ref.branch}:${ref.dir}`;
  const hit = shaCache.get(key);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.sha;
  let sha: string | null = null;
  try {
    const api =
      `https://api.github.com/repos/${ref.owner}/${ref.repo}/commits` +
      `?sha=${encodeURIComponent(ref.branch)}&per_page=1` +
      (ref.dir ? `&path=${encodeURIComponent(ref.dir)}` : '');
    const r = await githubFetch(api, { 'User-Agent': 'nanoclaw', Accept: 'application/vnd.github+json' });
    if (r.ok) {
      const commits = (await r.json()) as Array<{ sha?: string }>;
      sha = commits?.[0]?.sha ?? null;
    }
  } catch {
    /* best-effort */
  }
  shaCache.set(key, { at: Date.now(), sha });
  return sha;
}
/**
 * Read a skill's current SKILL.md as the AGENT sees it: its own scoped copy wins,
 * otherwise the shared pool (shipped skills, then the user pool). Used to show a
 * patch draft against the version it would actually replace. Empty string when the
 * target can't be resolved — the caller renders that as "new file".
 */
/** Resolve a draft's source session to its webchat room, when there is one. */
function draftSourceRoom(sessionId: string | null): string | null {
  if (!sessionId) return null;
  try {
    const sess = getSession(sessionId);
    if (!sess?.messaging_group_id) return null;
    const mg = getMessagingGroup(sess.messaging_group_id);
    return mg && mg.channel_type === 'webchat' ? mg.platform_id : null;
  } catch {
    return null;
  }
}

function parseAgentLearning(agentGroupId: string): { autoTrigger?: boolean; autoKeep?: boolean; cooldownMinutes?: number } {
  try {
    const raw = getContainerConfig(agentGroupId)?.learning;
    return raw ? (JSON.parse(raw) as ReturnType<typeof parseAgentLearning>) : {};
  } catch {
    return {};
  }
}

function readSkillBody(agentGroupId: string, skillName: string): string {
  const name = sanitizeSkillName(skillName);
  if (!name) return '';
  const candidates = [
    path.join(scopedSkillsDir(agentGroupId), name),
    path.join(process.cwd(), 'container', 'skills', name),
    path.join(USER_SKILLS_DIR, name),
  ];
  for (const dir of candidates) {
    try {
      return fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    } catch {
      /* try the next location */
    }
  }
  return '';
}

function readSkillOrigin(skillDir: string): SkillOrigin | null {
  try {
    return sanitizeOrigin(JSON.parse(fs.readFileSync(path.join(skillDir, '.origin.json'), 'utf8')));
  } catch {
    return null;
  }
}

type AvailableSkill = { name: string; description: string; source: 'shipped' | 'user'; origin?: SkillOrigin | null };
function listAvailableSkills(): AvailableSkill[] {
  const roots: Array<{ dir: string; source: 'shipped' | 'user' }> = [
    { dir: path.join(process.cwd(), 'container', 'skills'), source: 'shipped' },
    { dir: USER_SKILLS_DIR, source: 'user' },
  ];
  const out: AvailableSkill[] = [];
  const seen = new Set<string>();
  for (const { dir, source } of roots) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (seen.has(entry)) continue; // shipped already claimed this name
      try {
        const skillDir = path.join(dir, entry);
        if (!fs.statSync(skillDir).isDirectory()) continue;
        const text = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
        const fm = text.match(/^---\s*\n([\s\S]*?)\n---/);
        out.push({
          name: entry,
          description: fm ? frontMatterDescription(fm[1]) : '',
          source,
          origin: source === 'user' ? readSkillOrigin(skillDir) : null,
        });
        seen.add(entry);
      } catch {
        continue; // no SKILL.md → not a skill
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Per-agent (scoped) skills ───────────────────────────────────────────────
// A skill wired to ONE agent group, not the shared pool: it lives as a real
// directory in that group's own `.claude-shared/skills/` (mounted at
// ~/.claude/skills), so only that group loads it and `'all'` never fans it out.
// (Pooled skills show up in the same dir as symlinks into /app/user-skills —
// those aren't scoped; we only count real directories.)
function scopedSkillsDir(agentGroupId: string): string {
  return path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.claude-shared', 'skills');
}
function listScopedSkills(
  agentGroupId: string,
): Array<{ name: string; description: string; origin: SkillOrigin | null; invocations: number; hasHistory: boolean }> {
  const dir = scopedSkillsDir(agentGroupId);
  const out: Array<{ name: string; description: string; origin: SkillOrigin | null; invocations: number; hasHistory: boolean }> = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    try {
      const p = path.join(dir, entry);
      if (!fs.lstatSync(p).isDirectory()) continue; // lstat: skip pooled symlinks, keep real dirs
      const text = fs.readFileSync(path.join(p, 'SKILL.md'), 'utf8');
      const fm = text.match(/^---\s*\n([\s\S]*?)\n---/);
      let invocations = 0;
      try {
        invocations = parseInt(fs.readFileSync(path.join(p, '.invocations'), 'utf8'), 10) || 0;
      } catch {
        /* never invoked */
      }
      out.push({
        name: entry,
        description: fm ? frontMatterDescription(fm[1]) : '',
        origin: readSkillOrigin(p),
        invocations,
        hasHistory: listRevisions(dir, entry).length > 0,
      });
    } catch {
      continue; // symlink (isDirectory false via lstat) or no SKILL.md
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function sanitizeSkillName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

// fetch() that retries once on a 5xx or network error — GitHub's gateway
// returns transient 502s under load, which shouldn't fail a whole import.
async function githubFetch(url: string, headers: Record<string, string>): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
      if (r.status >= 500 && r.status < 600 && attempt < 1) {
        await new Promise((res) => setTimeout(res, 600));
        continue;
      }
      return r;
    } catch (err) {
      if (attempt < 1) {
        await new Promise((res) => setTimeout(res, 600));
        continue;
      }
      throw err;
    }
  }
}

// Recursively fetch a GitHub folder via the contents API. Input is host-locked
// to github.com (parsed by the caller); the API + download_urls only reach
// github's own hosts, so there's no SSRF surface. Capped in files + bytes.
async function fetchGithubDir(
  owner: string,
  repo: string,
  branch: string,
  dirPath: string,
): Promise<Array<{ rel: string; content: Buffer }>> {
  const MAX_FILES = 60;
  const MAX_BYTES = 8 * 1024 * 1024;
  const base = dirPath.replace(/\/+$/, '');
  // Walk the tree first (serial — each level needs its parent listing), then
  // download contents in parallel: script-heavy skills (xlsx: 54 files) took
  // ~10s serial, ~2s parallel.
  const files: Array<{ rel: string; download_url: string }> = [];
  let totalBytes = 0;
  async function walk(p: string): Promise<void> {
    const api = `https://api.github.com/repos/${owner}/${repo}/contents${p ? '/' + encodeURI(p) : ''}?ref=${encodeURIComponent(branch)}`;
    const r = await githubFetch(api, { 'User-Agent': 'nanoclaw', Accept: 'application/vnd.github+json' });
    if (!r.ok) throw new Error(`GitHub API ${r.status}`);
    const items = (await r.json()) as Array<{ type: string; path: string; download_url: string | null; size: number }>;
    if (!Array.isArray(items)) throw new Error('That URL is a file, not a folder');
    for (const it of items) {
      if (files.length >= MAX_FILES) throw new Error(`Too many files (>${MAX_FILES})`);
      if (it.type === 'dir') {
        await walk(it.path);
      } else if (it.type === 'file' && it.download_url) {
        totalBytes += it.size || 0;
        if (totalBytes > MAX_BYTES) throw new Error('Skill exceeds 8MB');
        files.push({ rel: it.path.slice(base.length).replace(/^\/+/, ''), download_url: it.download_url });
      }
    }
  }
  await walk(base);
  return Promise.all(
    files.map(async (f) => {
      const fr = await githubFetch(f.download_url, { 'User-Agent': 'nanoclaw' });
      if (!fr.ok) throw new Error(`Download ${fr.status}`);
      return { rel: f.rel, content: Buffer.from(await fr.arrayBuffer()) };
    }),
  );
}

// Skill collections (each a GitHub repo with one skill folder per entry under
// `dir`). The registry lives in webchat_skill_sources (seeded by migration 120,
// managed by global admins from Settings). Listing goes through the GitHub API
// (1 call); descriptions come from raw.githubusercontent (not API-rate-limited).
// Cached for an hour — catalogs change rarely and the API allows 60/hr.
const catalogCache = new Map<
  string,
  { at: number; skills: Array<{ name: string; description: string; url: string }> }
>();

// Fetch (or serve cached) the skill list for one source row. Throws only when
// there's no cache to fall back on.
async function loadCatalog(
  src: WebchatSkillSource,
): Promise<Array<{ name: string; description: string; url: string }>> {
  let entry = catalogCache.get(src.id);
  if (!entry || Date.now() - entry.at > 3600_000) {
    try {
      // Walk the repo tree once and take EVERY folder that contains a SKILL.md
      // at any depth under `dir` (empty dir = whole repo). This lets a collection
      // be a repo root, a single folder, or skills nested under category folders
      // (e.g. letta-ai/skills → letta/*, meta/*, tools/*) — not just one flat dir.
      const treeApi = `https://api.github.com/repos/${src.owner}/${src.repo}/git/trees/${src.branch}?recursive=1`;
      const r = await fetch(treeApi, {
        headers: { 'User-Agent': 'nanoclaw', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) throw new Error(`GitHub API ${r.status}`);
      const tree = ((await r.json()) as { tree?: Array<{ path: string; type: string }> }).tree || [];
      const prefix = src.dir && src.dir !== '.' ? src.dir.replace(/^\/+|\/+$/g, '') + '/' : '';
      const seen = new Set<string>();
      const folders: Array<{ folder: string; name: string }> = [];
      for (const t of tree) {
        if (t.type !== 'blob' || !t.path.endsWith('/SKILL.md')) continue;
        if (prefix && !t.path.startsWith(prefix)) continue;
        const folder = t.path.slice(0, -'/SKILL.md'.length);
        const name = sanitizeSkillName(folder.split('/').pop() || '');
        if (!name || seen.has(name)) continue; // first wins on a leaf-name collision
        seen.add(name);
        folders.push({ folder, name });
      }
      // A one-skill repo/folder: SKILL.md sits at `dir` itself (no subfolder),
      // e.g. jdilla1277/agentcad-skill (SKILL.md at the repo root). Surface it as
      // a single skill named after the repo (or the dir).
      if (folders.length === 0) {
        const rootBase = prefix.replace(/\/$/, '');
        if (tree.some((t) => t.type === 'blob' && t.path === `${prefix}SKILL.md`)) {
          const name = sanitizeSkillName((rootBase ? rootBase.split('/').pop() : src.repo) || src.repo);
          if (name) folders.push({ folder: rootBase, name });
        }
      }
      const skills = await Promise.all(
        folders.slice(0, 100).map(async ({ folder, name }) => {
          const sub = folder ? `${folder}/` : ''; // '' when the skill IS the repo/dir root
          // description is best-effort
          let description = '';
          try {
            const raw = await fetch(
              `https://raw.githubusercontent.com/${src.owner}/${src.repo}/${src.branch}/${sub}SKILL.md`,
              { headers: { 'User-Agent': 'nanoclaw' }, signal: AbortSignal.timeout(8000) },
            );
            if (raw.ok) {
              const fm = (await raw.text()).match(/^---\s*\n([\s\S]*?)\n---/);
              if (fm) description = frontMatterDescription(fm[1]);
            }
          } catch {
            /* best-effort */
          }
          return {
            name,
            description,
            url: `https://github.com/${src.owner}/${src.repo}/tree/${src.branch}${folder ? '/' + folder : ''}`,
          };
        }),
      );
      entry = { at: Date.now(), skills };
      catalogCache.set(src.id, entry);
    } catch (err) {
      // Serve a stale cache over an error if we have one.
      if (!entry) throw err;
    }
  }
  return entry.skills;
}

// The awesomeskill.ai marketplace — the ONE allowlisted discovery host, a
// community source pooled alongside the GitHub collections. Public, read-only.
const SKILL_DISCOVERY_URL = 'https://awesomeskill.ai/api/agent/skills/search';
const SKILL_DISCOVERY_SOURCE = { name: 'awesomeskill.ai', url: 'https://awesomeskill.ai' };
// Stable id for the code-wired marketplace, so an owner can switch it off like a
// GitHub collection (persisted in webchat_disabled_sources).
const MARKETPLACE_ID = 'awesomeskill';

// Fetch community skills from awesomeskill.ai. Empty query = browse top-by-stars
// (the default pool); otherwise search. Best-effort — returns [] on error so a
// marketplace outage can't blank the whole pool.
async function fetchMarketplace(
  q: string,
  limit = 25,
): Promise<
  Array<{ name: string; title: string; description: string; repo: string; stars: number; reviewUrl: string }>
> {
  const query = q.trim().slice(0, 100);
  try {
    const r = await fetch(`${SKILL_DISCOVERY_URL}?q=${encodeURIComponent(query)}&limit=${limit}&sort=stars`, {
      headers: { 'User-Agent': 'nanoclaw', Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`Discovery API ${r.status}`);
    const raw = (await r.json()) as unknown;
    const rec = raw as { results?: unknown; skills?: unknown; data?: unknown };
    const items = (Array.isArray(raw) ? raw : rec.results || rec.skills || rec.data || []) as Array<
      Record<string, unknown>
    >;
    return items
      .map((s) => {
        const repo = String(s.githubRepo || '').trim();
        return {
          name: sanitizeSkillName(String(s.name || '')),
          title: String(s.name || ''),
          description: String(s.description || ''),
          repo,
          stars: Number(s.githubStars) || 0,
          // Point Review at the actual code repo (repo is validated owner/repo
          // below), NOT the marketplace-supplied sourceUrl — that's third-party
          // controlled and would otherwise reach an <a href> unvalidated.
          reviewUrl: repo ? `https://github.com/${repo}` : '',
        };
      })
      .filter((s) => s.name && /^[^/]+\/[^/]+$/.test(s.repo));
  } catch {
    return [];
  }
}

type PoolSkill = {
  name: string;
  description: string;
  origin: SkillOrigin;
  installed: boolean;
  review: string; // GitHub URL to review before importing
  ref: { url: string } | { repo: string; name: string }; // import descriptor
};

// One merged, deduped pool of skills for a trust tier. Official = the Anthropic
// collection(s). Community = every community GitHub collection PLUS the
// awesomeskill.ai marketplace, all badged by origin and treated equally — no
// collection is privileged. A query filters GitHub collections by substring and
// searches the marketplace. Curated collections list first, so they win dedup
// over marketplace copies of the same skill.
async function catalogPoolHandler(res: ServerResponse, tier: string, q: string): Promise<void> {
  const wantOfficial = tier === 'official';
  const query = q.trim();
  const ql = query.toLowerCase();
  const installed = new Set(listAvailableSkills().map((s) => s.name));
  const tierSources = listSkillSources().filter((s) => !!s.official === wantOfficial);
  const out: PoolSkill[] = [];
  const seen = new Set<string>();
  for (const src of tierSources) {
    let skills: Array<{ name: string; description: string; url: string }>;
    try {
      skills = await loadCatalog(src);
    } catch {
      continue; // one bad source can't blank the pool
    }
    const origin: SkillOrigin = {
      label: src.official ? src.label.replace(/\s*\((?:official|community)\)\s*$/i, '') : `${src.owner}/${src.repo}`,
      url: `https://github.com/${src.owner}/${src.repo}`,
      official: !!src.official,
    };
    for (const s of skills) {
      const name = sanitizeSkillName(s.name);
      if (!name || seen.has(name)) continue;
      if (query && !`${name} ${s.description}`.toLowerCase().includes(ql)) continue;
      seen.add(name);
      out.push({
        name,
        description: s.description,
        origin,
        installed: installed.has(name),
        review: s.url,
        ref: { url: s.url },
      });
    }
  }
  if (!wantOfficial && !isSourceDisabled(MARKETPLACE_ID)) {
    const origin: SkillOrigin = {
      label: SKILL_DISCOVERY_SOURCE.name,
      url: SKILL_DISCOVERY_SOURCE.url,
      official: false,
    };
    for (const m of await fetchMarketplace(query)) {
      if (!m.name || seen.has(m.name)) continue;
      seen.add(m.name);
      out.push({
        name: m.name,
        description: m.description,
        origin,
        installed: installed.has(m.name),
        review: m.reviewUrl,
        ref: { repo: m.repo, name: m.title },
      });
    }
  }
  // Sort by name so collections interleave — no source is grouped first. (Dedup
  // above already let curated collections win over marketplace copies.)
  out.sort((a, b) => a.name.localeCompare(b.name));
  return json(res, 200, { tier, official: wantOfficial, skills: out });
}

// Parse a GitHub folder URL into skill-source components (shared by the source
// editor and validated the same way as skill imports).
function parseGithubDirUrl(url: string): { owner: string; repo: string; branch: string; dir: string } | null {
  const m = url.trim().match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+?)\/?$/);
  return m ? { owner: m[1], repo: m[2], branch: m[3], dir: m[4] } : null;
}

// Resolve a source URL into {owner, repo, branch, dir}. Accepts a folder URL
// (…/tree/branch/dir), a branch URL (…/tree/branch → whole branch), OR a bare
// repo root (…/owner/repo → default branch, whole repo). loadCatalog walks the
// tree from `dir`, so an empty dir means "find skills anywhere in the repo".
async function resolveSourceUrl(
  url: string,
): Promise<{ owner: string; repo: string; branch: string; dir: string } | null> {
  const u = url.trim();
  const folder = parseGithubDirUrl(u);
  if (folder) return folder;
  const branchOnly = u.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/?$/);
  if (branchOnly) return { owner: branchOnly[1], repo: branchOnly[2], branch: branchOnly[3], dir: '' };
  const root = u.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (root) {
    try {
      const r = await fetch(`https://api.github.com/repos/${root[1]}/${root[2]}`, {
        headers: { 'User-Agent': 'nanoclaw', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return null;
      const branch = ((await r.json()) as { default_branch?: string }).default_branch || 'main';
      return { owner: root[1], repo: root[2], branch, dir: '' };
    } catch {
      return null;
    }
  }
  return null;
}

async function putSkillSourceHandler(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const clean = sanitizeSkillName(id);
  if (!clean) return json(res, 400, { error: 'Invalid source id (a-z, 0-9, hyphens)' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { label?: unknown; url?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const parsed = await resolveSourceUrl(String(body.url || ''));
  if (!parsed) {
    return json(res, 400, {
      error: 'Expected a GitHub repo or folder URL, e.g. https://github.com/letta-ai/skills',
    });
  }
  // No label needed — name the collection after what it pulls in (owner/repo),
  // matching its badge everywhere. An explicit label still wins if one's sent.
  const label = String(body.label || '').trim() || `${parsed.owner}/${parsed.repo}`;
  // Verify the location actually lists skill folders before saving it. Admin-
  // added sources are always community (official=false); upsert ignores this
  // field, but the type requires it.
  const probe: WebchatSkillSource = { id: clean, label, ...parsed, official: false };
  catalogCache.delete(clean); // force a fresh fetch on edit
  try {
    const skills = await loadCatalog(probe);
    if (skills.length === 0) return json(res, 422, { error: 'That folder contains no skill directories' });
  } catch (err) {
    return json(res, 422, {
      error: 'Could not list that folder: ' + (err instanceof Error ? err.message : String(err)),
    });
  }
  upsertSkillSource(probe);
  return json(res, 200, { ok: true, source: { id: clean, label } });
}

// ── Skill suggestions for a new agent ───────────────────────────────────────
// Deterministic keyword scoring of the agent's name/description/instructions
// against installed skills + every catalog source. No LLM dependency: the
// create form calls this as the operator types, so it must be instant and work
// on installs with no local model. Synonyms bridge common phrasing gaps
// ("spreadsheet" → xlsx, "website" → frontend).
const SKILL_SYNONYMS: Record<string, string[]> = {
  pdf: ['pdf', 'pdfs', 'document', 'documents', 'form', 'forms'],
  docx: ['word', 'docx', 'document', 'documents', 'letter', 'report', 'reports'],
  xlsx: [
    'excel',
    'xlsx',
    'spreadsheet',
    'spreadsheets',
    'csv',
    'budget',
    'finance',
    'financial',
    'invoice',
    'invoices',
  ],
  pptx: ['powerpoint', 'pptx', 'presentation', 'presentations', 'slides', 'deck', 'decks'],
  'frontend-design': ['website', 'websites', 'frontend', 'ui', 'web', 'landing', 'design'],
  'web-artifacts-builder': ['website', 'webapp', 'web', 'app', 'artifact'],
  'webapp-testing': ['test', 'testing', 'qa', 'browser', 'e2e'],
  'mcp-builder': ['mcp', 'integration', 'integrations', 'tool', 'tools', 'server'],
  'skill-creator': ['skill', 'skills'],
  'canvas-design': ['poster', 'posters', 'graphic', 'graphics', 'visual', 'design', 'image'],
  'algorithmic-art': ['art', 'generative', 'creative', 'p5js'],
  'slack-gif-creator': ['gif', 'gifs', 'slack'],
  'brand-guidelines': ['brand', 'branding', 'style'],
  'internal-comms': ['announcement', 'announcements', 'comms', 'communication', 'newsletter'],
  'doc-coauthoring': ['write', 'writing', 'draft', 'drafting', 'edit', 'editing', 'coauthor'],
  'agent-browser': ['browse', 'browser', 'web', 'research', 'scrape', 'scraping', 'read', 'news'],
  'frontend-engineer': ['website', 'websites', 'frontend', 'web', 'react', 'ui'],
  'vercel-cli': ['deploy', 'deployment', 'vercel', 'ship', 'publish'],
  brainstorming: ['brainstorm', 'brainstorming', 'ideas', 'ideation', 'creative'],
  'writing-plans': ['plan', 'plans', 'planning'],
  'executing-plans': ['plan', 'plans', 'execute', 'workflow'],
};
const SUGGEST_STOPWORDS = new Set(
  'a an and are as at be by for from has have in is it its of on or that the this to use uses using when with you your agent assistant help helps'.split(
    ' ',
  ),
);

function suggestTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !SUGGEST_STOPWORDS.has(t)),
  );
}

async function suggestSkillsHandler(res: ServerResponse, text: string): Promise<void> {
  const tokens = suggestTokens(text);
  if (tokens.size === 0) return json(res, 200, { suggestions: [] });
  const installed = listAvailableSkills();
  const installedNames = new Set(installed.map((s) => s.name));
  // Candidates: installed skills + every catalog entry (cached; a cold cache
  // fetch can take a couple of seconds on the very first call — fine for a form).
  const candidates: Array<{ name: string; description: string; source: string; url?: string }> = installed.map((s) => ({
    name: s.name,
    description: s.description,
    source: 'installed',
  }));
  for (const src of listSkillSources()) {
    try {
      for (const s of await loadCatalog(src)) {
        if (!installedNames.has(sanitizeSkillName(s.name))) candidates.push({ ...s, source: src.label });
      }
    } catch {
      /* an unreachable catalog must not break suggestions */
    }
  }
  const suggestions = candidates
    .map((c) => {
      let score = 0;
      for (const t of suggestTokens(c.name.replace(/-/g, ' '))) if (tokens.has(t)) score += 3;
      for (const t of suggestTokens(c.description)) if (tokens.has(t)) score += 1;
      for (const syn of SKILL_SYNONYMS[c.name] || []) if (tokens.has(syn)) score += 3;
      return { ...c, score };
    })
    .filter((c) => c.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  return json(res, 200, { suggestions });
}

// Discovery gives a repo (owner/repo) + skill name, not the folder path. Walk
// the repo tree once and return the github folder URL of the SKILL.md whose
// parent dir matches the name — so a discovered skill imports through the same
// GitHub-only pipeline as a pasted folder URL.
async function resolveDiscoveredSkillUrl(repoRaw: string, name: string): Promise<string> {
  const m = repoRaw.trim().match(/(?:github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (!m) throw new Error('unrecognized repo');
  const [, owner, repo] = m;
  const gh = async (p: string) => {
    const r = await githubFetch(`https://api.github.com/repos/${owner}/${repo}${p}`, {
      'User-Agent': 'nanoclaw',
      Accept: 'application/vnd.github+json',
    });
    if (!r.ok) throw new Error(`GitHub API ${r.status}`);
    return r.json();
  };
  const branch = ((await gh('')) as { default_branch?: string }).default_branch || 'main';
  const tree =
    ((await gh(`/git/trees/${branch}?recursive=1`)) as { tree?: Array<{ path: string; type: string }> }).tree || [];
  const skillMds = tree.filter((t) => t.type === 'blob' && /(^|\/)SKILL\.md$/i.test(t.path));
  const want = sanitizeSkillName(name);
  const parentDir = (p: string) => p.split('/').slice(-2)[0] || '';
  const match =
    skillMds.find((t) => sanitizeSkillName(parentDir(t.path)) === want) ||
    skillMds.find((t) => sanitizeSkillName(parentDir(t.path)).includes(want) && want.length >= 3) ||
    (skillMds.length === 1 ? skillMds[0] : null);
  if (!match) throw new Error("couldn't pinpoint the skill folder — open the repo and import the folder URL by hand");
  const dir = match.path.replace(/\/?SKILL\.md$/i, '');
  if (!dir) throw new Error('skill lives at the repo root — import the repo URL by hand');
  return `https://github.com/${owner}/${repo}/tree/${branch}/${dir}`;
}

async function importSkillHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { url?: unknown; repo?: unknown; name?: unknown; origin?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  let url = String(body.url || '').trim();
  // Discovery import: resolve {repo, name} into a github folder URL first.
  if (!url && body.repo) {
    try {
      url = await resolveDiscoveredSkillUrl(String(body.repo), String(body.name || ''));
    } catch (err) {
      return json(res, 422, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  // Accept a folder URL (…/tree/branch/dir), a branch URL, OR a bare repo root —
  // the last covers a one-skill repo whose SKILL.md is at the root (e.g.
  // jdilla1277/agentcad-skill). Empty dir → import the repo/branch root.
  const resolved = await resolveSourceUrl(url);
  if (!resolved) {
    return json(res, 400, {
      error: 'Expected a GitHub repo or folder URL, e.g. https://github.com/owner/repo or .../tree/main/skill-folder',
    });
  }
  const { owner, repo, branch, dir } = resolved;
  // Provenance: trust the client's display label (catalog collection or the
  // marketplace it was discovered from), but fall back to the git owner/repo —
  // which is the real code origin and can't be spoofed, since it's parsed from
  // the fetch URL above.
  const origin: SkillOrigin = sanitizeOrigin(body.origin) ?? {
    label: `${owner}/${repo}`,
    url: `https://github.com/${owner}/${repo}`,
    official: false,
  };
  // Pin the import: record where it came from and the commit it was taken at,
  // so "update available" is checkable later. Best-effort — never blocks.
  origin.ref = { owner, repo, branch, dir };
  origin.sha = (await latestCommitSha(origin.ref, 0)) ?? undefined;
  // Name after the skill folder, or the repo itself when the skill is the root.
  const skillName = sanitizeSkillName((dir ? dir.split('/').pop() : repo) || repo);
  if (!skillName) return json(res, 400, { error: 'Could not derive a skill name from the URL' });
  if (fs.existsSync(path.join(process.cwd(), 'container', 'skills', skillName))) {
    return json(res, 409, { error: `A built-in skill named "${skillName}" already exists` });
  }
  let files: Array<{ rel: string; content: Buffer }>;
  try {
    files = await fetchGithubDir(owner, repo, branch, dir);
  } catch (err) {
    return json(res, 502, { error: 'Fetch failed: ' + (err instanceof Error ? err.message : String(err)) });
  }
  if (!files.some((f) => f.rel === 'SKILL.md')) {
    return json(res, 422, { error: 'That folder has no SKILL.md — not an Agent Skill' });
  }
  // Stage in a temp dir, then swap into place so a failed import can't leave a
  // half-written skill.
  const dest = path.join(USER_SKILLS_DIR, skillName);
  const staging = `${dest}.importing`;
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    for (const f of files) {
      const target = path.join(staging, f.rel);
      if (target !== staging && !target.startsWith(staging + path.sep)) continue; // no traversal
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.content);
    }
    fs.writeFileSync(path.join(staging, '.origin.json'), JSON.stringify(origin));
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(staging, dest);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    return json(res, 500, { error: 'Write failed: ' + (err instanceof Error ? err.message : String(err)) });
  }
  // Callers that skipped the /inspect preview (direct API use, the agent-create
  // wizard's batch) still get the lint findings in the response.
  const inspection = inspectSkillFiles(skillName, files, { official: origin.official });
  return json(res, 200, { ok: true, name: skillName, files: files.length, warnings: inspection.warnings });
}

/**
 * Pre-import preview: resolve the same body /api/skills/import takes, fetch the
 * files, inspect — write NOTHING. The client shows this before the user
 * confirms; a failed preview falls back to the old text-only confirm.
 */
function escapeHtml(t: string): string {
  return t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

async function inspectSkillHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { url?: unknown; repo?: unknown; name?: unknown; official?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  let url = String(body.url || '').trim();
  if (!url && body.repo) {
    try {
      url = await resolveDiscoveredSkillUrl(String(body.repo), String(body.name || ''));
    } catch (err) {
      return json(res, 422, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  const resolved = await resolveSourceUrl(url);
  if (!resolved) return json(res, 400, { error: 'Expected a GitHub repo or folder URL' });
  const { owner, repo, branch, dir } = resolved;
  const skillName = sanitizeSkillName((dir ? dir.split('/').pop() : repo) || repo);
  let files: Array<{ rel: string; content: Buffer }>;
  try {
    files = await fetchGithubDir(owner, repo, branch, dir);
  } catch (err) {
    return json(res, 502, { error: 'Fetch failed: ' + (err instanceof Error ? err.message : String(err)) });
  }
  if (!files.some((f) => f.rel === 'SKILL.md')) {
    return json(res, 422, { error: 'That folder has no SKILL.md — not an Agent Skill' });
  }
  return json(res, 200, {
    name: skillName,
    ...inspectSkillFiles(skillName, files, { official: !!body.official }),
  });
}

/** Pool skills whose pinned upstream has moved: {name, hasUpdate}. */
async function skillUpdatesHandler(res: ServerResponse): Promise<void> {
  const updates: Array<{ name: string; hasUpdate: boolean }> = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(USER_SKILLS_DIR);
  } catch {
    /* no pool yet */
  }
  await Promise.all(
    entries.map(async (name) => {
      const origin = readSkillOrigin(path.join(USER_SKILLS_DIR, name));
      if (!origin?.sha || !origin.ref) return; // unpinned (pre-pinning import or hand-written)
      const latest = await latestCommitSha(origin.ref);
      if (latest) updates.push({ name, hasUpdate: latest !== origin.sha });
    }),
  );
  return json(res, 200, { updates: updates.sort((a, b) => a.name.localeCompare(b.name)) });
}

/**
 * Re-import a pinned pool skill from its recorded ref at upstream HEAD. The
 * outgoing version is snapshotted into the pool's .history first — an update
 * is as revertible as a learned-skill patch.
 */
async function applySkillUpdateHandler(res: ServerResponse, name: string): Promise<void> {
  const clean = sanitizeSkillName(name);
  const dest = path.join(USER_SKILLS_DIR, clean);
  if (!clean || !fs.existsSync(dest)) return json(res, 404, { error: 'Skill not found' });
  const origin = readSkillOrigin(dest);
  if (!origin?.ref) return json(res, 409, { error: 'This skill has no recorded source to update from' });
  let files: Array<{ rel: string; content: Buffer }>;
  try {
    files = await fetchGithubDir(origin.ref.owner, origin.ref.repo, origin.ref.branch, origin.ref.dir);
  } catch (err) {
    return json(res, 502, { error: 'Fetch failed: ' + (err instanceof Error ? err.message : String(err)) });
  }
  if (!files.some((f) => f.rel === 'SKILL.md')) {
    return json(res, 422, { error: 'Upstream no longer has a SKILL.md at the recorded path' });
  }
  try {
    snapshotRevision(USER_SKILLS_DIR, clean);
  } catch {
    /* history is protection, not a gate */
  }
  const newSha = (await latestCommitSha(origin.ref, 0)) ?? undefined;
  const staging = `${dest}.updating`;
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    for (const f of files) {
      const target = path.join(staging, f.rel);
      if (target !== staging && !target.startsWith(staging + path.sep)) continue; // no traversal
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.content);
    }
    fs.writeFileSync(path.join(staging, '.origin.json'), JSON.stringify({ ...origin, sha: newSha }));
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(staging, dest);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    return json(res, 500, { error: 'Write failed: ' + (err instanceof Error ? err.message : String(err)) });
  }
  const inspection = inspectSkillFiles(clean, files, { official: origin.official });
  return json(res, 200, { ok: true, name: clean, files: files.length, warnings: inspection.warnings });
}

const TRIAL_SKILLS_ROOT = path.join(DATA_DIR, 'trial-skills');

/**
 * Start (or resume) a trial for a draft: write the draft body as an overlay
 * skill under data/trial-skills/<group>/<thread>/, create a "Trial:" thread in
 * the draft's source room, and let the per-session overlay mount
 * (container-runner) do the isolation. Re-pressing Try refreshes the overlay
 * body and reuses the existing thread — no thread spam.
 */
function startSkillTrialHandler(res: ServerResponse, draft: SkillDraft): void {
  const roomId = draftSourceRoom(draft.session_id);
  if (!roomId) return json(res, 409, { error: 'This draft has no webchat source room to trial in' });
  const body = readSkillDraftBody(draft.id);
  if (!body) return json(res, 410, { error: 'Draft body missing' });
  const isPatch = draft.kind === 'patch' && !!draft.target_skill;
  const name = sanitizeSkillName(isPatch ? String(draft.target_skill) : draft.skill_name);
  if (!name) return json(res, 400, { error: 'Invalid skill name' });

  const groupRoot = path.join(TRIAL_SKILLS_ROOT, draft.agent_group_id);
  // Resume: an existing overlay for this draft whose thread still exists.
  try {
    for (const threadId of fs.existsSync(groupRoot) ? fs.readdirSync(groupRoot) : []) {
      const marker = path.join(groupRoot, threadId, name, '.trial.json');
      try {
        const m = JSON.parse(fs.readFileSync(marker, 'utf8')) as { draftId?: string };
        if (m.draftId !== draft.id) continue;
        if (!getWebchatThread(roomId, threadId)) continue;
        fs.writeFileSync(path.join(groupRoot, threadId, name, 'SKILL.md'), body); // refresh edits
        return json(res, 200, { ok: true, roomId, threadId, name, resumed: true });
      } catch {
        continue;
      }
    }
  } catch {
    /* fall through to a fresh trial */
  }

  const thread = createWebchatThread(roomId, `Trial: ${name}`.slice(0, 80));
  const dir = path.join(groupRoot, thread.thread_id, name);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
    fs.writeFileSync(path.join(dir, '.trial.json'), JSON.stringify({ draftId: draft.id, createdAt: Date.now() }));
  } catch (err) {
    return json(res, 500, { error: 'Write failed: ' + (err instanceof Error ? err.message : String(err)) });
  }
  broadcastRooms(); // the new thread shows up in every sidebar
  return json(res, 200, { ok: true, roomId, threadId: thread.thread_id, name });
}

/** Remove every trial overlay belonging to a draft (called when it resolves). */
export function cleanupTrialOverlays(draftId: string): void {
  let groups: string[] = [];
  try {
    groups = fs.readdirSync(TRIAL_SKILLS_ROOT);
  } catch {
    return;
  }
  for (const g of groups) {
    let threads: string[] = [];
    try {
      threads = fs.readdirSync(path.join(TRIAL_SKILLS_ROOT, g));
    } catch {
      continue;
    }
    for (const t of threads) {
      const threadDir = path.join(TRIAL_SKILLS_ROOT, g, t);
      let names: string[] = [];
      try {
        names = fs.readdirSync(threadDir);
      } catch {
        continue;
      }
      for (const n of names) {
        try {
          const m = JSON.parse(fs.readFileSync(path.join(threadDir, n, '.trial.json'), 'utf8')) as {
            draftId?: string;
          };
          if (m.draftId !== draftId) continue;
          fs.rmSync(path.join(threadDir, n), { recursive: true, force: true });
          if (fs.readdirSync(threadDir).length === 0) fs.rmSync(threadDir, { recursive: true, force: true });
        } catch {
          continue;
        }
      }
    }
  }
}

function deleteUserSkillHandler(res: ServerResponse, name: string): void {
  const clean = sanitizeSkillName(name);
  if (clean && fs.existsSync(path.join(process.cwd(), 'container', 'skills', clean))) {
    return json(res, 403, { error: 'Built-in skills cannot be deleted' });
  }
  const dir = path.join(USER_SKILLS_DIR, clean);
  if (!clean || !fs.existsSync(dir)) return json(res, 404, { error: 'Skill not found' });
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return json(res, 200, { ok: true });
  } catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// Read a skill's SKILL.md (either source) for the viewer/editor.
function getSkillContentHandler(res: ServerResponse, name: string): void {
  const clean = sanitizeSkillName(name);
  if (!clean) return json(res, 404, { error: 'Skill not found' });
  const shipped = path.join(process.cwd(), 'container', 'skills', clean, 'SKILL.md');
  const user = path.join(USER_SKILLS_DIR, clean, 'SKILL.md');
  const file = fs.existsSync(shipped) ? shipped : fs.existsSync(user) ? user : null;
  if (!file) return json(res, 404, { error: 'Skill not found' });
  try {
    return json(res, 200, {
      name: clean,
      source: file === shipped ? 'shipped' : 'user',
      content: fs.readFileSync(file, 'utf8'),
    });
  } catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// Create or edit a USER skill's SKILL.md — the upload/manual-edit path. Only
// the SKILL.md is writable here; extra files come via GitHub import (or the
// host filesystem at data/user-skills/<name>/). Requires front-matter with a
// description so the picker isn't full of blanks.
async function putUserSkillHandler(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
  const clean = sanitizeSkillName(name);
  if (!clean) return json(res, 400, { error: 'Invalid skill name (a-z, 0-9, hyphens)' });
  if (fs.existsSync(path.join(process.cwd(), 'container', 'skills', clean))) {
    return json(res, 403, { error: 'Built-in skills are read-only — create one under a different name' });
  }
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let content = '';
  try {
    content = String((JSON.parse(raw) as { content?: unknown }).content || '');
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (content.length > 512 * 1024) return json(res, 413, { error: 'SKILL.md exceeds 512KB' });
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fm || !/^description:\s*\S/m.test(fm[1])) {
    return json(res, 422, {
      error: 'SKILL.md needs YAML front-matter with a description (--- name/description ---)',
    });
  }
  try {
    const skillDir = path.join(USER_SKILLS_DIR, clean);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);
    // Hand-authored here → "custom". Only stamp when there's no origin yet, so
    // editing an imported skill's SKILL.md never overwrites its provenance.
    const originFile = path.join(skillDir, '.origin.json');
    if (!fs.existsSync(originFile)) {
      fs.writeFileSync(originFile, JSON.stringify({ label: 'custom' } satisfies SkillOrigin));
    }
    return json(res, 200, { ok: true, name: clean });
  } catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// Pull `description` from YAML front-matter, handling the common shapes: an
// inline value, quoted, or a folded/literal block scalar (>- | etc.) whose text
// continues on the following indented lines.
function frontMatterDescription(fmBody: string): string {
  const lines = fmBody.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^description:\s*(.*)$/);
    if (!m) continue;
    const val = m[1].trim();
    if (['>', '>-', '|', '|-'].includes(val)) {
      const parts: string[] = [];
      for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) parts.push(lines[j].trim());
      return parts.join(' ');
    }
    return val.replace(/^["']|["']$/g, '');
  }
  return '';
}

async function setAgentSkillsHandler(req: IncomingMessage, res: ServerResponse, agentGroupId: string): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { skills?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (!Array.isArray(body.skills)) return json(res, 400, { error: 'skills array required' });
  const available = new Set(listAvailableSkills().map((s) => s.name));
  const skills = [...new Set(body.skills.map(String).filter((s) => available.has(s)))];
  // Persist the explicit selection (switches the agent off the 'all' default) and
  // respawn so syncSkillSymlinks re-points .claude/skills before the next turn.
  updateContainerConfigJson(agentGroupId, 'skills', skills);
  const restarted = restartAgentGroupContainers(agentGroupId, 'Webchat skills changed');
  return json(res, 200, { ok: true, skills, restarted });
}

// Import a GitHub skill wired to ONE agent group: staged into that group's own
// .claude-shared/skills/<name> (a real dir), so only that group loads it. Accepts
// a repo/folder URL (incl. a bare repo root for a one-skill repo).
async function importScopedSkillHandler(
  req: IncomingMessage,
  res: ServerResponse,
  agentGroupId: string,
): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { url?: unknown; repo?: unknown; name?: unknown; origin?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  let url = String(body.url || '').trim();
  // Marketplace items arrive as {repo, name} — resolve to a folder URL first.
  if (!url && body.repo) {
    try {
      url = await resolveDiscoveredSkillUrl(String(body.repo), String(body.name || ''));
    } catch (err) {
      return json(res, 422, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  const resolved = await resolveSourceUrl(url);
  if (!resolved) {
    return json(res, 400, { error: 'Expected a GitHub repo or folder URL, e.g. https://github.com/owner/repo' });
  }
  const { owner, repo, branch, dir } = resolved;
  const origin: SkillOrigin = sanitizeOrigin(body.origin) ?? {
    label: `${owner}/${repo}`,
    url: `https://github.com/${owner}/${repo}`,
    official: false,
  };
  const skillName = sanitizeSkillName((dir ? dir.split('/').pop() : repo) || repo);
  if (!skillName) return json(res, 400, { error: 'Could not derive a skill name from the URL' });
  // A pooled skill of this name would collide with the 'all' symlink in the same
  // dir — steer the user to plain assignment instead of a scoped copy.
  if (
    fs.existsSync(path.join(process.cwd(), 'container', 'skills', skillName)) ||
    fs.existsSync(path.join(USER_SKILLS_DIR, skillName))
  ) {
    return json(res, 409, { error: `A shared skill named "${skillName}" already exists — assign it below instead` });
  }
  let files: Array<{ rel: string; content: Buffer }>;
  try {
    files = await fetchGithubDir(owner, repo, branch, dir);
  } catch (err) {
    return json(res, 502, { error: 'Fetch failed: ' + (err instanceof Error ? err.message : String(err)) });
  }
  if (!files.some((f) => f.rel === 'SKILL.md')) {
    return json(res, 422, { error: 'That folder has no SKILL.md — not an Agent Skill' });
  }
  origin.ref = { owner, repo, branch, dir };
  origin.sha = (await latestCommitSha(origin.ref, 0)) ?? undefined;
  const dir0 = scopedSkillsDir(agentGroupId);
  const dest = path.join(dir0, skillName);
  const staging = `${dest}.importing`;
  try {
    fs.mkdirSync(dir0, { recursive: true });
    fs.rmSync(staging, { recursive: true, force: true });
    for (const f of files) {
      const target = path.join(staging, f.rel);
      if (target !== staging && !target.startsWith(staging + path.sep)) continue; // no traversal
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.content);
    }
    fs.writeFileSync(path.join(staging, '.origin.json'), JSON.stringify(origin));
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(staging, dest);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    return json(res, 500, { error: 'Write failed: ' + (err instanceof Error ? err.message : String(err)) });
  }
  const restarted = restartAgentGroupContainers(agentGroupId, 'Webchat scoped skill added');
  const inspection = inspectSkillFiles(skillName, files, { official: origin.official });
  return json(res, 200, { ok: true, name: skillName, files: files.length, restarted, warnings: inspection.warnings });
}

// Remove a scoped skill (a real dir) from a group's .claude-shared/skills. Only
// touches real directories — never a pooled-skill symlink.
function deleteScopedSkillHandler(res: ServerResponse, agentGroupId: string, name: string): void {
  const clean = sanitizeSkillName(name);
  if (!clean) return json(res, 400, { error: 'Invalid skill name' });
  const dir = path.join(scopedSkillsDir(agentGroupId), clean);
  let isRealDir = false;
  try {
    isRealDir = fs.lstatSync(dir).isDirectory();
  } catch {
    return json(res, 404, { error: 'Skill not wired to this agent' });
  }
  if (!isRealDir) return json(res, 404, { error: 'Skill not wired to this agent' }); // a symlink = pooled, not scoped
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
  const restarted = restartAgentGroupContainers(agentGroupId, 'Webchat scoped skill removed');
  return json(res, 200, { ok: true, restarted });
}

// Flip the in-room "proposed skill" card (if the draft was surfaced in a webchat
// room) so it stops being actionable, and push the update to connected clients.
function resolveDraftCard(draftId: string, outcome: 'kept' | 'discarded', userId: string): void {
  const flipped = markRoomSkillDraftResolved(draftId, outcome, userId);
  if (flipped) broadcast(flipped.roomId, { type: 'message', ...flipped.message });
}

// Keep + wire a learning-loop draft: write its SKILL.md into the chosen agent's
// own .claude-shared/skills (scoped, origin "learned"), then mark it kept.
async function keepSkillDraftHandler(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
  draft: { id: string; skill_name: string; kind?: string; target_skill?: string | null },
): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let agentGroupId = '';
  try {
    agentGroupId = String((JSON.parse(raw) as { agentGroupId?: unknown }).agentGroupId || '');
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const group = resolveAgent(agentGroupId);
  if (!group) return json(res, 404, { error: 'Agent not found' });
  if (!hasAdminPrivilege(userId, group.id)) return json(res, 403, { error: 'Admin privilege required' });
  // The write itself lives in modules/learning/apply.ts — ONE implementation
  // shared with auto-keep, so the two paths cannot drift.
  const r = applySkillDraft({ ...draft, agent_group_id: group.id } as Parameters<typeof applySkillDraft>[0],
    draft.kind === 'patch' ? 'Webchat skill revision applied' : 'Webchat learned skill kept');
  if (!r.ok) return json(res, r.status, { error: r.error });
  resolveDraftCard(draft.id, 'kept', userId);
  return json(res, 200, { ok: true, name: r.name, patched: r.patched, forkedFromPool: r.forkedFromPool, restarted: r.restarted });
}

function listAgentMcpHandler(res: ServerResponse, agentGroupId: string): void {
  const attached = getMcpServersForAgent(agentGroupId).map(mcpServerForUI);
  return json(res, 200, { servers: attached });
}

/** Attach/detach registry servers: body { add: [ids], remove: [ids] }. */
async function setAgentMcpHandler(req: IncomingMessage, res: ServerResponse, agentGroupId: string): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { add?: unknown; remove?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const add = Array.isArray(body.add) ? body.add.map(String) : [];
  const remove = Array.isArray(body.remove) ? body.remove.map(String) : [];
  if (add.length === 0 && remove.length === 0) return json(res, 400, { error: 'add or remove required' });
  let changed = 0;
  for (const id of add) {
    const server = getWebchatMcpServer(id);
    if (!server) return json(res, 404, { error: `MCP server not found: ${id}` });
    assignMcpServerToAgent(agentGroupId, id);
    syncAgentMcpConfig(agentGroupId, server, true);
    changed++;
  }
  for (const id of remove) {
    const server = getWebchatMcpServer(id);
    if (!server) return json(res, 404, { error: `MCP server not found: ${id}` });
    unassignMcpServerFromAgent(agentGroupId, id);
    syncAgentMcpConfig(agentGroupId, server, false);
    changed++;
  }
  if (changed > 0) reloadAgentMcpServers(agentGroupId);
  return json(res, 200, { ok: true, servers: getMcpServersForAgent(agentGroupId).map(mcpServerForUI) });
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
