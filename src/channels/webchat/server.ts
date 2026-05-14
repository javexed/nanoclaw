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
 *   GET  /api/rooms/:id/messages                 history (?after_id= for incremental)
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
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { getDb, hasTable } from '../../db/connection.js';
import { log } from '../../log.js';
import type { AgentGroup } from '../../types.js';
import {
  createAgentGroup,
  deleteAgentGroup,
  getAgentGroup,
  getAllAgentGroups,
  updateAgentGroup,
} from '../../db/agent-groups.js';
import { createMessagingGroupAgent, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { getPendingApproval } from '../../db/sessions.js';
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
import type { InboundMessage, OutboundFile } from '../adapter.js';
import {
  assertBearerTokenStrength,
  authenticateRequest,
  hasExplicitAuth,
  requiresExplicitAuth,
  warnIfAutoProxyTrust,
} from './auth.js';
import {
  approvalInboxForUser,
  assignModelToAgent,
  clearPrimeAgentForWebchatRoom,
  countAgentsForWebchatRoom,
  createWebchatModel,
  createWebchatRoom,
  deleteWebchatModel,
  deleteWebchatRoom,
  getAgentsAssignedToModel,
  getAgentsForWebchatRoom,
  getAllWebchatRooms,
  getAssignedModelForAgent,
  getPrimeAgentForWebchatRoom,
  getWebchatMessages,
  getWebchatMessagesAfterId,
  getWebchatModel,
  getWebchatPendingApprovalsForUser,
  getWebchatRoom,
  listWebchatModels,
  setPrimeAgentForWebchatRoom,
  storeWebchatFileMessage,
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
import { hasAdminPrivilege, isOwner, warnIfNoPermissionsModule } from './roles.js';
import { canAccessRoom, filterRoomsForUser } from './access.js';
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

  if ((tlsCert && !tlsKey) || (!tlsCert && tlsKey)) {
    log.warn('Webchat: both WEBCHAT_TLS_CERT and WEBCHAT_TLS_KEY must be set for HTTPS — falling back to HTTP');
  }

  const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
    void handleHttp(req, res, hooks, publicDir).catch((err) => {
      log.error('Webchat HTTP handler threw', { err });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error' }));
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
    return json(res, 200, filterRoomsForUser(userId, getAllWebchatRooms()));
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
  if (roomAgentsMatch && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') {
      return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    }
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    return addAgentToRoomHandler(req, res, decodeURIComponent(roomAgentsMatch[1]));
  }

  const roomAgentMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/agents\/([^/]+)$/);
  if (roomAgentMatch && method === 'DELETE') {
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    return removeAgentFromRoomHandler(
      res,
      decodeURIComponent(roomAgentMatch[1]),
      decodeURIComponent(roomAgentMatch[2]),
    );
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

  const histMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/messages$/);
  if (histMatch && method === 'GET') {
    const room = getWebchatRoom(histMatch[1]);
    if (!room) return json(res, 404, { error: 'Room not found' });
    if (!canAccessRoom(userId, room.id)) return json(res, 403, { error: 'Access denied' });
    const afterId = url.searchParams.get('after_id');
    const msgs = afterId ? getWebchatMessagesAfterId(room.id, afterId, 200) : getWebchatMessages(room.id, 100);
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
    if (req.headers['x-webchat-csrf'] !== '1') {
      return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    }
    const roomId = decodeURIComponent(uploadMatch[1]);
    if (!canAccessRoom(userId, roomId)) return json(res, 403, { error: 'Access denied' });
    return handleMultipartUpload(req, res, roomId, senderIdentity, userId, hooks);
  }
  const chunkMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/upload\/chunk$/);
  if (chunkMatch && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') {
      return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    }
    const roomId = decodeURIComponent(chunkMatch[1]);
    if (!canAccessRoom(userId, roomId)) return json(res, 403, { error: 'Access denied' });
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
    return json(res, 200, listAgentsForUser(userId));
  }

  // POST /api/agents/draft must come BEFORE the /api/agents/:id pattern
  // (which would otherwise match 'draft' as an id) AND before the bare
  // /api/agents POST so the literal-path handlers stay distinct.
  if (url.pathname === '/api/agents/draft' && method === 'POST') {
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    if (req.headers['x-webchat-csrf'] !== '1') {
      return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    }
    return draftAgentHandler(req, res);
  }

  if (url.pathname === '/api/agents' && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') {
      return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    }
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    return createAgentHandler(req, res);
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

  // ── Per-agent model assignment ─────────────────────────────────────────
  const agentModelMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/model$/);
  if (agentModelMatch && method === 'PUT') {
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    const group = resolveAgent(decodeURIComponent(agentModelMatch[1]));
    if (!group) return json(res, 404, { error: 'Agent not found' });
    return assignAgentModelHandler(req, res, group.id);
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
    const expectedPlatformId = approvalInboxForUser(userId);
    if (pending.channel_type !== 'webchat' || pending.platform_id !== expectedPlatformId) {
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

  // ── Permissions (owner-only) ──────────────────────────────────────────
  if (url.pathname === '/api/users' && method === 'GET') {
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    return json(res, 200, listUsersWithPermissions());
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
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { userId?: unknown; kind?: unknown; agentGroupId?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    return grantPermissionHandler(res, body, userId);
  }
  if (url.pathname === '/api/permissions/revoke' && method === 'POST') {
    if (req.headers['x-webchat-csrf'] !== '1') {
      return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    }
    if (!isOwner(userId)) return json(res, 403, { error: 'Owner only' });
    const raw = await readJsonBody(req, res);
    if (raw === null) return;
    let body: { userId?: unknown; kind?: unknown; agentGroupId?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    return revokePermissionHandler(res, body);
  }

  // ── Stubs for v1-PWA dashboard endpoints we cut from the PR ──────────
  // Return empty/safe shapes so the PWA renders cleanly when the user
  // browses to the tasks/stats/routes views. These will be replaced by
  // v2-shaped endpoints (and a v2-aware PWA) in a follow-up.
  if (url.pathname === '/api/tasks' && method === 'GET') return json(res, 200, []);
  if (url.pathname === '/api/routes' && method === 'GET') return json(res, 200, {});
  if (url.pathname === '/api/stats' && method === 'GET') return json(res, 200, null);

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
  res.writeHead(200, { 'Content-Type': contentType });
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
  // Wirings changed — recompute engage patterns in case this room has a
  // prime configured. No-op when no prime is set (leaves the default '.').
  recomputeEngagePatterns(platformId);
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
    for (const w of wirings) update.run('.', w.id);
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

function listAgentsForUser(userId: string): AgentForUI[] {
  const all = getAllAgentGroups();
  const visible = isOwner(userId) ? all : all.filter((g) => hasAdminPrivilege(userId, g.id));
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

function listUsersWithPermissions(): UserWithPermissions[] {
  const users = permsGetAllUsers();
  const groups = getAllAgentGroups();
  // Pre-fetch members once per group, keep the full audit-rich rows so we
  // can surface added_by / added_at to the UI.
  const membersByGroup = new Map(groups.map((g) => [g.id, permsGetMembers(g.id)]));

  return users.map((u) => {
    const roles: RoleEntry[] = permsGetUserRoles(u.id).map((r) => ({
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
  const targetUserId = typeof body.userId === 'string' ? body.userId.trim() : '';
  if (!targetUserId) return { error: 'userId required' };
  if (!targetUserId.includes(':')) return { error: 'userId must be namespaced (e.g. webchat:tailscale:foo@bar.com)' };
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

async function createAgentHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    return json(res, 200, { ok: true, agentGroup: result.group, roomId: null });
  }

  const roomName = typeof body.roomName === 'string' && body.roomName.trim() ? body.roomName.trim() : name;
  const provisioned = provisionWebchatAgentWithRoom(roomName, {
    folder: typeof body.folder === 'string' ? body.folder : undefined,
    instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
  });
  if ('error' in provisioned) return json(res, provisioned.status, { error: provisioned.error });
  broadcastRooms();
  return json(res, 200, {
    ok: true,
    agentGroup: provisioned.group,
    roomId: provisioned.group.folder,
  });
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

  // Tear down wiring + room first so referential cleanup is complete before
  // the agent_groups row is removed. Wirings for OTHER rooms (this agent may
  // be wired to multiple) get caught by the agent_group_id sweep below;
  // deleteWebchatRoom only handles the one room with this agent's folder id.
  const db = getDb();
  db.prepare(`DELETE FROM messaging_group_agents WHERE agent_group_id = ?`).run(id);
  // Drop the model assignment too — the agent is going away, no point
  // keeping a row pointing at a dead agent_group_id.
  unassignModelFromAgent(id);
  // Also drop agent_destinations rows owned by this agent — the FK
  // (agent_destinations.agent_group_id REFERENCES agent_groups.id) would
  // otherwise block the deleteAgentGroup below. Guarded — a2a module may
  // not be installed, in which case the table is absent.
  if (hasTable(db, 'agent_destinations')) {
    db.prepare(`DELETE FROM agent_destinations WHERE agent_group_id = ?`).run(id);
  }
  deleteWebchatRoom(group.folder);
  deleteAgentGroup(id);

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
      // Auto-prime: the first agent on a freshly-created room becomes
      // prime by default. Sole agent → engages on every message (same as
      // no-prime behavior). Multi-agent at creation → first wire is the
      // default responder; the operator can flip via room settings.
      // Done inside the transaction so a partial failure doesn't leave a
      // dangling prime row pointing at a non-wired agent.
      if (wireIds.length > 0) {
        setPrimeAgentForWebchatRoom(roomId, wireIds[0]);
      }
    })();
    // recomputeEngagePatterns reads the current wirings + prime, so it
    // has to run AFTER the transaction commits. The result for the sole-
    // agent case is unchanged ('.'), so this is only meaningful for
    // multi-agent room creation.
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

  // deleteWebchatRoom drops messages, wirings, and the messaging_group row.
  // Agents are deliberately preserved — they may be wired to other rooms,
  // and DELETE /api/agents/:id is the cascade-to-agent path.
  deleteWebchatRoom(roomId);

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

async function addAgentToRoomHandler(req: IncomingMessage, res: ServerResponse, roomId: string): Promise<void> {
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
    agentId = parsed.id;
  } else {
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
  // Endpoint or model_id change → re-emit env for every agent that uses it.
  for (const agentGroupId of getAgentsAssignedToModel(id)) {
    try {
      writeAgentSettingsForAssignedModel(agentGroupId);
    } catch (err) {
      log.warn('Webchat: settings.json refresh after model update failed', { agentGroupId, err });
    }
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
  // Refresh settings.json for any newly-orphaned agents so their next
  // spawn doesn't keep using the dead env block.
  for (const agentGroupId of assigned) {
    try {
      writeAgentSettingsForAssignedModel(agentGroupId);
    } catch (err) {
      log.warn('Webchat: settings.json refresh after model delete failed', { agentGroupId, err });
    }
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
  try {
    writeAgentSettingsForAssignedModel(agentGroupId);
  } catch (err) {
    log.warn('Webchat: settings.json write after model assign failed', { agentGroupId, err });
  }
  const current = getAssignedModelForAgent(agentGroupId);
  return json(res, 200, { ok: true, model: current });
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
