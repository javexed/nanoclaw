/**
 * Webchat HTTP server — single-user build.
 *
 * Serves the PWA shell, gates every /api/* route behind bearer/localhost
 * auth, dispatches a declarative route table, and upgrades /ws to the
 * realtime protocol (ws.ts).
 *
 * The predecessor's server.ts was 4,000 lines carrying ~180 routes; this one
 * keeps the same skeleton (security headers, pre-auth static serving, route
 * table with guards, in-memory compressed asset cache, SW cache-version
 * stamping) with only the routes the single-user build needs. Management
 * routes (agents, models, ollama, installs) join the table as their
 * milestones land.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { createHash, randomUUID } from 'crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'http';
import { createServer as createHttpsServer } from 'https';

import { log } from '../../log.js';
import type { InboundMessage, OutboundFile } from '../adapter.js';
import {
  assertBearerTokenStrength,
  authenticateRequest,
  getAuthInfo,
  hasExplicitAuth,
  requiresExplicitAuth,
} from './auth.js';
import { setupWebSocket } from './ws.js';
import { json, readJsonBody } from './server/http.js';
import { broadcast, broadcastRooms, annotateRooms } from './state.js';
import {
  createWebchatRoom,
  getWebchatPendingApprovalsForUser,
  deleteWebchatRoom,
  getAgentsForWebchatRoom,
  getWebchatMessagesBeforeId,
  getWebchatMessagesAfterId,
  getWebchatMessages,
  getWebchatRoom,
  sanitizeRoomName,
  setPrimeAgentForWebchatRoom,
  updateWebchatRoomName,
  type FileMeta,
} from './db.js';
import { redactSensitiveData } from './redact.js';
import { handleFileServe, handleMultipartUpload, uploadsDir } from './files.js';
import {
  rAgentDelete,
  rAgentModelPut,
  rAgentsDetailGet,
  rAgentsDraftPost,
  rAgentsPost,
  rModelIdDelete,
  rModelIdPut,
  rModelsDefaultPut,
  rModelsDiscoverPost,
  rModelsGet,
  rModelsPost,
  rModelsProbePost,
  rModelsReachabilityPost,
  rOllamaDeletePost,
  rOllamaHostsGet,
  rOllamaInstallPost,
  rOllamaLocalGet,
  rOllamaModelsGet,
  rOllamaPullCancelPost,
  rOllamaPullPost,
  rOllamaPullsGet,
  rOllamaRecommendGet,
  rRoomAgentDelete,
  rRoomAgentsPost,
} from './server/routes-manage.js';
import { getAgentGroup, getAllAgentGroups } from '../../db/agent-groups.js';
import { createMessagingGroupAgent, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3100;

export interface WebchatServerHooks {
  onInbound: (roomId: string, message: InboundMessage) => void;
  onAction: (questionId: string, selectedOption: string, userId: string) => void;
}

export interface WebchatServer {
  host: string;
  port: number;
  tls: boolean;
  http: HttpServer;
  wss: import('ws').WebSocketServer;
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
  if (requiresExplicitAuth(host) && !(await hasExplicitAuth())) {
    throw new Error(
      `Webchat refusing to bind to ${host}:${port}: no auth method configured. ` +
        'Set WEBCHAT_TOKEN, or bind to 127.0.0.1 instead.',
    );
  }
  // Refuse to start with a weak bearer token regardless of bind host.
  assertBearerTokenStrength();

  if ((tlsCert && !tlsKey) || (!tlsCert && tlsKey)) {
    log.warn('Webchat: both WEBCHAT_TLS_CERT and WEBCHAT_TLS_KEY must be set for HTTPS — falling back to HTTP');
  }

  const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
    void handleHttp(req, res, hooks, publicDir).catch((err) => {
      log.error('Webchat HTTP handler threw', { err });
      if (!res.headersSent) {
        // Webchat is single-tenant + auth-gated; surface err.message so the
        // operator gets a real diagnostic instead of "Internal error".
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

  const wss = setupWebSocket(httpServer, { onInbound: hooks.onInbound }, async (req) => {
    const auth = await authenticateRequest(req);
    if (!auth.ok) return null;
    return { userId: auth.userId, displayName: auth.displayName };
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', (err: NodeJS.ErrnoException) => {
      // EADDRINUSE on this port is almost always "another nanoclaw host is
      // already running for this checkout" — surface cause + recovery before
      // rethrowing instead of the registry's generic adapter failure.
      if (err.code === 'EADDRINUSE') {
        log.error(`Webchat: port ${port} already in use — another nanoclaw host is likely running for this checkout.`, {
          host,
          port,
        });
      }
      reject(err);
    });
    httpServer.listen(port, host, () => {
      log.info('Webchat HTTP listening', { host, port, tls: tlsEnabled });
      resolve();
    });
  });

  return {
    host,
    port,
    tls: tlsEnabled,
    http: httpServer,
    wss,
    broadcast: (roomId, payload) => {
      void broadcast(roomId, payload as object);
    },
    persistOutboundFile: (roomId, file) => persistOutboundFile(roomId, file),
  };
}

export async function stopWebchatServer(server: WebchatServer): Promise<void> {
  // close() waits for every open socket — and a webchat server ALWAYS has
  // open sockets (connected PWAs, WebSocket upgrades, keep-alive API calls).
  // closeAllConnections() EXCLUDES upgraded sockets by design, so terminate
  // the WS clients first, then the rest — otherwise shutdown hangs until
  // systemd's SIGKILL and every routine restart reads as unclean.
  for (const client of server.wss.clients) client.terminate();
  server.wss.close();
  server.http.closeAllConnections?.();
  await new Promise<void>((resolve) => {
    server.http.close(() => resolve());
  });
  log.info('Webchat HTTP stopped');
}

// ── Outbound file persistence (agent → user attachments) ────────────────────
// Files arriving via OutboundMessage.files are written into the same uploads
// tree the browser uploads use (files.ts owns the layout) and served back
// through the same /api/files route.

export function persistOutboundFile(roomId: string, file: OutboundFile): string {
  const safeRoom = roomId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = uploadsDir(roomId);
  fs.mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const safeName = path.basename(file.filename).replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
  const stored = `${id}-${safeName}`;
  fs.writeFileSync(path.join(dir, stored), file.data);
  return `/api/files/${safeRoom}/${stored}`;
}

// ── HTTP request handler ────────────────────────────────────────────────────

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
  // ever bypassed, script-src 'self' stops injected <script>/handlers/eval —
  // defense-in-depth behind the sanitizer. Everything is same-origin and
  // vendored; the WS is same-origin so 'self' covers it; img allows
  // data:/blob: (thumbnails). style-src keeps 'unsafe-inline' for the handful
  // of inline style= attrs — style injection is low-risk and the script
  // protection stays strict.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; connect-src 'self' https://www.gstatic.com; font-src 'self'; " +
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
  // Pre-auth, public — the login screen reads this to tell the user which
  // methods are configured. Booleans only; no tokens or IPs.
  if (url.pathname === '/api/auth/info' && method === 'GET') {
    return json(res, 200, await getAuthInfo());
  }

  // Static PWA assets — the app shell that CONTAINS the login screen — must
  // be reachable BEFORE auth, or a token-only deployment 401s index.html and
  // the user never sees the field to enter their token. servePwa only serves
  // real files under publicDir (path-traversal guarded), so every /api/*
  // route still falls through to the auth gate below.
  if (method === 'GET' && servePwa(req, res, publicDir)) return;

  const auth = await authenticateRequest(req);
  if (!auth.ok) {
    return json(res, 401, { error: auth.reason });
  }
  const userId = auth.userId;
  const senderIdentity = auth.displayName;

  if (url.pathname === '/api/auth/check' && method === 'GET') {
    return json(res, 200, { ok: true, userId, identity: senderIdentity });
  }

  // Uploaded/outbound files (auth-gated — private attachments).
  {
    const m = url.pathname.match(/^\/api\/files\/([^/]+)\/([^/]+)$/);
    if (m && method === 'GET') {
      handleFileServe(res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
      return;
    }
    const up = url.pathname.match(/^\/api\/files\/([^/]+)$/);
    if (up && (method === 'POST' || method === 'PUT')) {
      if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
      await handleMultipartUpload(req, res, decodeURIComponent(up[1]), senderIdentity, userId, {
        onInbound: (roomId, message) => hooks.onInbound(roomId, message),
      });
      return;
    }
  }

  for (const r of API_ROUTES) {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    if (!methods.includes(method)) continue;
    const m =
      typeof r.path === 'string'
        ? url.pathname === r.path
          ? ([url.pathname] as unknown as RegExpMatchArray)
          : null
        : url.pathname.match(r.path);
    if (!m) continue;
    for (const g of r.guards ?? []) {
      if (g === 'csrf' && req.headers['x-webchat-csrf'] !== '1')
        return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
    }
    return r.h({ req, res, url, method, userId, senderIdentity, hooks }, m);
  }

  return json(res, 404, { error: 'Not found' });
}

// ── Route table ─────────────────────────────────────────────────────────────

export interface RouteCtx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  userId: string;
  senderIdentity: string;
  hooks: WebchatServerHooks;
}

/**
 * Single-user: every authenticated caller IS the owner, so the predecessor's
 * 'owner'/'anyAdmin' guards collapse away. 'csrf' stays — it's a cross-site
 * protection, not a privilege check.
 */
type RouteGuard = 'csrf';

interface ApiRoute {
  method: string | string[];
  path: string | RegExp; // string = exact url.pathname match
  guards?: RouteGuard[];
  h: (ctx: RouteCtx, m: RegExpMatchArray) => void | Promise<void>;
}

// ── Room routes ─────────────────────────────────────────────────────────────

/** Agents, for the room-create picker and (M4) the management panel. */
async function rAgentsGet({ res }: RouteCtx): Promise<void> {
  const groups = await getAllAgentGroups();
  return json(
    res,
    200,
    groups.map((g) => ({ id: g.id, name: g.name, folder: g.folder })),
  );
}

async function rRoomsGet({ res }: RouteCtx): Promise<void> {
  return json(res, 200, { rooms: await annotateRooms() });
}

/**
 * Create a room, optionally wiring an agent in the same call. The wiring is a
 * `messaging_group_agents` row with the always-engage pattern — one agent per
 * room, catching every message (no @-mention dance needed in a room with one
 * agent). Also stamped as the room's prime for the management panel.
 */
async function rRoomsPost(ctx: RouteCtx): Promise<void> {
  const { req, res } = ctx;
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { name?: unknown; agent_group_id?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const name = sanitizeRoomName(body.name);
  if (!name) return json(res, 400, { error: 'Room name required (1-80 printable chars)' });

  const agentGroupId = typeof body.agent_group_id === 'string' ? body.agent_group_id : null;
  if (agentGroupId && !(await getAgentGroup(agentGroupId))) {
    return json(res, 404, { error: 'Agent group not found' });
  }

  const room = await createWebchatRoom(name);
  if (agentGroupId) {
    await wireAgentToRoom(room.id, agentGroupId);
  }
  await broadcastRooms();
  return json(res, 200, { room });
}

export async function wireAgentToRoom(roomId: string, agentGroupId: string): Promise<void> {
  const mg = await getMessagingGroupByPlatform('webchat', roomId);
  if (!mg) throw new Error(`wireAgentToRoom: room ${roomId} has no messaging_groups row`);
  const wired = await getAgentsForWebchatRoom(roomId);
  if (wired.some((a) => a.id === agentGroupId)) return;
  await createMessagingGroupAgent({
    id: randomUUID(),
    messaging_group_id: mg.id,
    agent_group_id: agentGroupId,
    engage_mode: 'pattern',
    engage_pattern: '.', // one agent per room: it answers everything
    sender_scope: 'all',
    ignored_message_policy: 'accumulate',
    session_mode: 'shared',
    priority: 0,
    created_at: new Date().toISOString(),
  });
  await setPrimeAgentForWebchatRoom(roomId, agentGroupId);
}

const RE_ROOM_NAME = /^\/api\/rooms\/([^/]+)\/name$/;
const RE_ROOM = /^\/api\/rooms\/([^/]+)$/;
const RE_ROOM_AGENTS = /^\/api\/rooms\/([^/]+)\/agents$/;
const RE_HISTORY = /^\/api\/history\/([^/]+)$/;

async function rRoomNamePut({ req, res }: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const roomId = decodeURIComponent(m[1]);
  if (!(await getWebchatRoom(roomId))) return json(res, 404, { error: 'Room not found' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { name?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const name = sanitizeRoomName(body.name);
  if (!name) return json(res, 400, { error: 'Room name required (1-80 printable chars)' });
  await updateWebchatRoomName(roomId, name);
  await broadcastRooms();
  return json(res, 200, { ok: true });
}

async function rRoomDelete({ res }: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const roomId = decodeURIComponent(m[1]);
  if (!(await getWebchatRoom(roomId))) return json(res, 404, { error: 'Room not found' });
  await deleteWebchatRoom(roomId);
  await broadcastRooms();
  return json(res, 200, { ok: true });
}

async function rRoomAgentsGet({ res }: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const roomId = decodeURIComponent(m[1]);
  if (!(await getWebchatRoom(roomId))) return json(res, 404, { error: 'Room not found' });
  return json(res, 200, { agents: await getAgentsForWebchatRoom(roomId) });
}

/** Paginated history: newest page by default, or the page before `?before=<id>`. */
async function rHistoryGet({ res, url }: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const roomId = decodeURIComponent(m[1]);
  if (!(await getWebchatRoom(roomId))) return json(res, 404, { error: 'Room not found' });
  const before = url.searchParams.get('before');
  const after = url.searchParams.get('after');
  const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
  const messages = before
    ? await getWebchatMessagesBeforeId(roomId, before, limit)
    : after
      ? await getWebchatMessagesAfterId(roomId, after, limit)
      : await getWebchatMessages(roomId, limit);
  return json(res, 200, {
    room_id: roomId,
    messages: messages.map((msg) => ({ ...msg, content: redactSensitiveData(msg.content) })),
  });
}

// ── Approval routes ─────────────────────────────────────────────────────────

/** Pending approvals for this user's inbox — the PWA refetches on connect. */
async function rApprovalsPendingGet({ res, userId }: RouteCtx): Promise<void> {
  const rows = await getWebchatPendingApprovalsForUser(userId);
  return json(res, 200, {
    approvals: rows.map((r) => ({
      questionId: r.approval_id,
      action: r.action,
      title: r.title,
      options: JSON.parse(r.options_json || '[]'),
      created_at: r.created_at,
    })),
  });
}

const RE_APPROVE = /^\/api\/approvals\/([^/]+)\/respond$/;

/**
 * Resolve an approval card. Routes through the SAME dispatch a platform
 * button-click takes (hooks.onAction → core response registry), so the claim
 * guard, authorization, and handler dispatch are identical to every other
 * channel. The response is fire-and-forget host-side; resolution reaches the
 * client via the approval_resolved broadcast.
 */
async function rApprovalRespondPost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId, hooks } = ctx;
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { value?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const value = typeof body.value === 'string' ? body.value : '';
  if (!value) return json(res, 400, { error: 'value required' });
  hooks.onAction(decodeURIComponent(m[1]), value, userId);
  return json(res, 200, { ok: true });
}

const RE_AGENT = /^\/api\/agents\/([^/]+)$/;
const RE_AGENT_MODEL = /^\/api\/agents\/([^/]+)\/model$/;
const RE_ROOM_AGENT = /^\/api\/rooms\/([^/]+)\/agents\/([^/]+)$/;
const RE_MODEL = /^\/api\/models\/([^/]+)$/;

const API_ROUTES: ApiRoute[] = [
  { method: 'GET', path: '/api/approvals/pending', h: rApprovalsPendingGet },
  { method: 'POST', path: RE_APPROVE, guards: ['csrf'], h: rApprovalRespondPost },
  // Management: agents
  { method: 'GET', path: '/api/agents/detail', h: rAgentsDetailGet },
  { method: 'POST', path: '/api/agents', guards: ['csrf'], h: rAgentsPost },
  { method: 'POST', path: '/api/agents/draft', guards: ['csrf'], h: rAgentsDraftPost },
  { method: 'DELETE', path: RE_AGENT, guards: ['csrf'], h: rAgentDelete },
  { method: 'PUT', path: RE_AGENT_MODEL, guards: ['csrf'], h: rAgentModelPut },
  { method: 'POST', path: RE_ROOM_AGENTS, guards: ['csrf'], h: rRoomAgentsPost },
  { method: 'DELETE', path: RE_ROOM_AGENT, guards: ['csrf'], h: rRoomAgentDelete },
  // Management: models
  { method: 'GET', path: '/api/models', h: rModelsGet },
  { method: 'POST', path: '/api/models', guards: ['csrf'], h: rModelsPost },
  { method: 'PUT', path: '/api/models/default', guards: ['csrf'], h: rModelsDefaultPut },
  { method: 'PUT', path: RE_MODEL, guards: ['csrf'], h: rModelIdPut },
  { method: 'DELETE', path: RE_MODEL, guards: ['csrf'], h: rModelIdDelete },
  { method: 'POST', path: '/api/models/discover', guards: ['csrf'], h: rModelsDiscoverPost },
  { method: 'POST', path: '/api/models/probe', guards: ['csrf'], h: rModelsProbePost },
  { method: 'POST', path: '/api/models/reachability', guards: ['csrf'], h: rModelsReachabilityPost },
  // Management: Ollama console
  { method: 'GET', path: '/api/ollama/hosts', h: rOllamaHostsGet },
  { method: 'GET', path: '/api/ollama/models', h: rOllamaModelsGet },
  { method: 'GET', path: '/api/ollama/pulls', h: rOllamaPullsGet },
  { method: 'POST', path: '/api/ollama/pull', guards: ['csrf'], h: rOllamaPullPost },
  { method: 'POST', path: '/api/ollama/pull/cancel', guards: ['csrf'], h: rOllamaPullCancelPost },
  { method: 'POST', path: '/api/ollama/delete', guards: ['csrf'], h: rOllamaDeletePost },
  { method: 'GET', path: '/api/ollama/recommend', h: rOllamaRecommendGet },
  { method: 'GET', path: '/api/ollama/local', h: rOllamaLocalGet },
  { method: 'POST', path: '/api/ollama/install', guards: ['csrf'], h: rOllamaInstallPost },
  { method: 'GET', path: '/api/agents', h: rAgentsGet },
  { method: 'GET', path: '/api/rooms', h: rRoomsGet },
  { method: 'POST', path: '/api/rooms', guards: ['csrf'], h: rRoomsPost },
  { method: 'PUT', path: RE_ROOM_NAME, guards: ['csrf'], h: rRoomNamePut },
  { method: 'DELETE', path: RE_ROOM, guards: ['csrf'], h: rRoomDelete },
  { method: 'GET', path: RE_ROOM_AGENTS, h: rRoomAgentsGet },
  { method: 'GET', path: RE_HISTORY, h: rHistoryGet },
];

// ── Static serving ──────────────────────────────────────────────────────────

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
};

// Text assets we compress before sending. Images are already compressed —
// running them through gzip/brotli wastes CPU for ~0% gain.
const COMPRESSIBLE_EXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.md', '.webmanifest']);

/**
 * Derive the service-worker cache name from a hash of every served asset
 * (except sw.js itself), so the cache busts exactly when an asset changes.
 * Sorted for determinism; recomputed per sw.js fetch (infrequent), so no
 * memoization is needed and none can go stale.
 */
export function computeSwCacheVersion(publicDir: string): string {
  let entries: string[];
  try {
    // Recursive: the emitted /js/ module tree must count toward the version,
    // or a client-code change would never bust the cache.
    entries = fs.readdirSync(publicDir, { recursive: true }).map(String).sort();
  } catch {
    return 'nanoclaw-web-dev';
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
  return 'nanoclaw-web-' + hash.digest('hex').slice(0, 12);
}

// In-memory asset cache keyed by path → { raw, per-encoding compressed, etag }.
// Invalidated by (mtimeMs, size): a redeploy re-reads + re-compresses on the
// next request; unchanged files serve from memory.
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

// Pick the best encoding the client accepts (brotli > gzip > identity), but
// only for compressible types. Compressed bytes are memoized per asset version.
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
  // asset hash so the service worker's cache name tracks asset content. Its
  // body is computed per request (infrequent), so compress inline uncached.
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
  // `no-cache` = browser MAY cache but must revalidate before reuse —
  // deliberate: it stops browsers/proxies holding stale assets across
  // deploys. The content-hash ETag makes revalidation cheap (304, empty
  // body). Freshness across deploys is owned by the SW cache version.
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

export type { FileMeta };
