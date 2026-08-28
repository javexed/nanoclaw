/**
 * Webchat HTTP/WS authentication — single-user build.
 *
 * Two methods, tried in order:
 *   - bearer token   WEBCHAT_TOKEN set; matched constant-time. The PWA passes
 *                    it via `Authorization: Bearer` or, on WebSocket upgrade,
 *                    `Sec-WebSocket-Protocol: bearer.<token>` so the secret
 *                    stays out of URLs (and therefore proxy access logs).
 *   - localhost      auto-pass when the remote IP is loopback AND no explicit
 *                    method is configured. If a bearer token is active we must
 *                    NOT trust loopback unconditionally: a fronting proxy
 *                    (Tailscale Serve, nginx, Caddy) terminates the public
 *                    hostname and forwards to 127.0.0.1, so unauthenticated
 *                    remote traffic would otherwise bypass auth entirely.
 *
 * Identities: `webchat:owner` (bearer), `webchat:local-owner` (localhost).
 * The first identity to authenticate is auto-granted role='owner' so trunk's
 * approver resolution (pickApprover → owner) lands approvals in this user's
 * webchat inbox.
 *
 * The predecessor also carried tailscale-whois and trusted-proxy/SSO
 * branches; nanoclaw-web keeps Tailscale as NETWORK access + HTTPS (Serve)
 * only — identity is always bearer or localhost.
 */
import { type IncomingMessage } from 'http';
import { timingSafeEqual } from 'crypto';

import { hasTable, getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import { upsertUser } from '../../modules/permissions/db/users.js';
import { getBearerTokenDisabled } from './db.js';

const WEBCHAT_TOKEN = process.env.WEBCHAT_TOKEN || '';
// Bind host (see channels/webchat/index.ts — default 127.0.0.1). A loopback
// bind means the server is reachable only from this machine, so the localhost
// auto-owner is the whole security story: no token, no network exposure.
const WEBCHAT_HOST = (process.env.WEBCHAT_HOST || '127.0.0.1').trim();

/** Is the server bound to a loopback interface (single-machine reach)? */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === '' || h === 'localhost' || h === '::1' || h.startsWith('127.');
}

export interface AuthResult {
  ok: true;
  userId: string;
  displayName: string;
  source: 'localhost' | 'bearer';
}

export interface AuthFailure {
  ok: false;
  reason: string;
}

/**
 * Auth events, deduplicated. authenticateRequest runs on EVERY HTTP request
 * and WS upgrade, so raw emission would write a line per API call. What a
 * review needs is TRANSITIONS: the first time an identity shows up over a
 * given source+ip since boot, and refusals (rate-limited per ip).
 */
const loggedSessions = new Set<string>();
const loggedDenials = new Map<string, number>();

export async function authenticateRequest(req: IncomingMessage): Promise<AuthResult | AuthFailure> {
  const result = await authenticate(req);
  const remoteIp = (req.socket.remoteAddress ?? '127.0.0.1').replace(/^::ffff:/, '');
  if (result.ok) {
    const key = `${result.userId}|${result.source}|${remoteIp}`;
    if (!loggedSessions.has(key)) {
      loggedSessions.add(key);
      log.info('Webchat auth session', { userId: result.userId, source: result.source, ip: remoteIp });
    }
  } else {
    const last = loggedDenials.get(remoteIp) ?? 0;
    if (Date.now() - last > 60_000) {
      loggedDenials.set(remoteIp, Date.now());
      log.warn('Webchat auth denied', { ip: remoteIp });
    }
  }
  return result;
}

async function authenticate(req: IncomingMessage): Promise<AuthResult | AuthFailure> {
  const remoteIp = (req.socket.remoteAddress ?? '127.0.0.1').replace(/^::ffff:/, '');

  // 1. Bearer token.
  const providedToken = extractBearer(req);
  if ((await bearerActive()) && providedToken && safeEqual(providedToken, WEBCHAT_TOKEN)) {
    return finalize({ source: 'bearer', userId: 'webchat:owner', displayName: 'operator' });
  }

  // 2. Localhost auto-pass — ONLY when no explicit auth method is configured.
  if (isLocalhost(remoteIp) && !(await hasExplicitAuth())) {
    const localUser = process.env.USER || process.env.USERNAME || 'user';
    return finalize({ source: 'localhost', userId: 'webchat:local-owner', displayName: localUser });
  }

  return { ok: false, reason: 'Unauthorized' };
}

/** True when the configured network mode requires at least one explicit auth method. */
export function requiresExplicitAuth(host: string): boolean {
  return !isLoopbackHost(host);
}

/**
 * Whether the bearer token is currently a usable auth method: configured AND
 * not retired by the owner (webchat_settings.bearer_token_disabled).
 */
async function bearerActive(): Promise<boolean> {
  return Boolean(WEBCHAT_TOKEN) && !(await getBearerTokenDisabled());
}

/** True when at least one non-localhost auth method is currently usable. */
export async function hasExplicitAuth(): Promise<boolean> {
  return bearerActive();
}

/** What the login screen needs to render before any auth succeeds. */
export async function getAuthInfo(): Promise<{ methods: string[]; loopbackOnly: boolean }> {
  const methods: string[] = [];
  if (await bearerActive()) methods.push('bearer');
  const loopbackOnly = isLoopbackHost(WEBCHAT_HOST);
  if (loopbackOnly && methods.length === 0) methods.push('localhost');
  return { methods, loopbackOnly };
}

const MIN_BEARER_TOKEN_LENGTH = 24;

/**
 * Refuse to start with a too-short bearer token. Called from the server boot
 * gate so misconfigurations fail loudly rather than silently weakening auth.
 */
export function assertBearerTokenStrength(): void {
  if (WEBCHAT_TOKEN && WEBCHAT_TOKEN.length < MIN_BEARER_TOKEN_LENGTH) {
    throw new Error(
      `Webchat refusing to start: WEBCHAT_TOKEN is ${WEBCHAT_TOKEN.length} chars, ` +
        `must be at least ${MIN_BEARER_TOKEN_LENGTH}. Generate one with: ` +
        `python3 -c "import secrets; print(secrets.token_urlsafe(32))"`,
    );
  }
}

// ── Internals ───────────────────────────────────────────────────────────────

function extractBearer(req: IncomingMessage): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
  const wsProto = req.headers['sec-websocket-protocol'];
  if (!wsProto) return undefined;
  const protos = (Array.isArray(wsProto) ? wsProto.join(',') : wsProto).split(',').map((s) => s.trim());
  const bearer = protos.find((p) => p.startsWith('bearer.'));
  return bearer ? bearer.slice('bearer.'.length) : undefined;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function isLocalhost(ip: string): boolean {
  const clean = ip.replace(/^::ffff:/, '');
  return clean === '127.0.0.1' || clean === '::1' || clean === 'localhost';
}

/**
 * First-login owner grant. Atomic guard: insert iff there's no owner yet —
 * SQLite evaluates the SELECT and INSERT in one statement under a row-write
 * lock, so a concurrent caller racing the same first-login window can't
 * squeeze a second INSERT through. Both webchat identities (bearer's
 * `webchat:owner` and loopback's `webchat:local-owner`) funnel through here;
 * whichever authenticates first becomes the install owner, which is what
 * routes approvals to this user's inbox.
 */
async function ensureOwnerRoleOnFirstLogin(userId: string): Promise<void> {
  const db = getDb();
  if (!(await hasTable(db, 'user_roles'))) return;
  try {
    const result = await db.run(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
         SELECT ?, 'owner', NULL, NULL, ?
         WHERE NOT EXISTS (SELECT 1 FROM user_roles WHERE role = 'owner')`,
      userId,
      new Date().toISOString(),
    );
    if (result.changes > 0) {
      log.info('Webchat: granted owner role to first authenticated user', { userId });
    }
  } catch (err) {
    log.warn('Webchat: failed to grant initial owner role', { userId, err });
  }
}

async function finalize(args: {
  source: AuthResult['source'];
  userId: string;
  displayName: string;
}): Promise<AuthResult> {
  // Upsert the users row so the identity exists for sender resolution and the
  // role grant below has somewhere to point. Guarded so a tree without the
  // users table still authenticates instead of throwing.
  if (await hasTable(getDb(), 'users')) {
    try {
      await upsertUser({
        id: args.userId,
        kind: 'webchat',
        display_name: args.displayName || null,
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      log.warn('Webchat: upsertUser failed during auth finalize', { userId: args.userId, err });
    }
  }
  await ensureOwnerRoleOnFirstLogin(args.userId);
  return { ok: true, userId: args.userId, displayName: args.displayName, source: args.source };
}
