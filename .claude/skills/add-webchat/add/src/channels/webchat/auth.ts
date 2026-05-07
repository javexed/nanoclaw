/**
 * Webchat HTTP/WS authentication.
 *
 * Auth methods (any combination, controlled by env presence):
 *   - localhost                always passes when remote IP is loopback
 *   - bearer token             WEBCHAT_TOKEN set; matched constant-time
 *   - tailscale whois          IP looked up via `tailscale whois --json`
 *   - trusted-proxy header     WEBCHAT_TRUSTED_PROXY_IPS = "auto" | "*" | csv
 *
 * Returns a v2-namespaced user id (`webchat:<...>`) plus a display name.
 * The first identity to authenticate gets auto-granted role='owner' when the
 * permissions module is installed; subsequent identities get no role until
 * granted (so admin endpoints will refuse them unless an owner explicitly
 * promotes them).
 *
 * If permissions isn't installed, authenticated callers are implicitly fully
 * privileged (the v2 command-gate degrades to allow-all without `user_roles`).
 */
import { type IncomingMessage } from 'http';
import { execFile } from 'child_process';
import { timingSafeEqual } from 'crypto';

import { hasTable, getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import { upsertUser } from '../../modules/permissions/db/users.js';
import { ensureOwnerRoleOnFirstLogin } from './roles.js';

const WEBCHAT_TOKEN = process.env.WEBCHAT_TOKEN || '';
const TRUSTED_PROXY_RAW = (process.env.WEBCHAT_TRUSTED_PROXY_IPS || '').trim();
const TRUSTED_PROXY_HEADER = (process.env.WEBCHAT_TRUSTED_PROXY_HEADER || 'x-forwarded-user').toLowerCase();
const TAILSCALE_ENABLED = process.env.WEBCHAT_TAILSCALE === 'true';

/**
 * Trusted proxy modes:
 *   "auto" — accept identity from any platform-managed proxy. Detects per
 *            request (Azure EasyAuth, Cloudflare Access). Headers are NOT
 *            cryptographically verified — only safe if the server is reachable
 *            EXCLUSIVELY through the proxy.
 *   "*"    — trust the configured header from any source IP (most permissive)
 *   IP/CIDR list — explicit allowlist (recommended)
 */
const TRUST_ANY_PLATFORM = TRUSTED_PROXY_RAW === 'auto' || TRUSTED_PROXY_RAW === '*';

const TRUSTED_PROXY_ENTRIES = TRUST_ANY_PLATFORM
  ? []
  : TRUSTED_PROXY_RAW.split(',')
      .map((s) => s.trim())
      .filter(Boolean);

const PLATFORM_HEADERS: Array<{ identity: string; verify: string; name: string }> = [
  // Azure App Service EasyAuth — x-ms-client-principal is a signed blob the platform injects.
  { identity: 'x-ms-client-principal-name', verify: 'x-ms-client-principal', name: 'Azure EasyAuth' },
  // Cloudflare Access — Cf-Access-Jwt-Assertion accompanies the email header.
  { identity: 'cf-access-authenticated-user-email', verify: 'cf-access-jwt-assertion', name: 'Cloudflare Access' },
];

export interface AuthResult {
  ok: true;
  userId: string;
  displayName: string;
  source: 'localhost' | 'bearer' | 'tailscale' | 'proxy-header';
}

export interface AuthFailure {
  ok: false;
  reason: string;
}

export async function authenticateRequest(req: IncomingMessage): Promise<AuthResult | AuthFailure> {
  const remoteIp = (req.socket.remoteAddress ?? '127.0.0.1').replace(/^::ffff:/, '');

  // 1. Bearer token from Authorization header or WebSocket subprotocol.
  //    PWA passes via `Sec-WebSocket-Protocol: bearer.<token>` so the secret
  //    stays out of URLs (and therefore out of proxy access logs).
  const providedToken = extractBearer(req);
  if (WEBCHAT_TOKEN && providedToken && safeEqual(providedToken, WEBCHAT_TOKEN)) {
    return finalize({ source: 'bearer', userId: 'webchat:owner', displayName: 'operator' });
  }

  // 2. Trusted proxy header — proxy is the auth authority.
  const proxy = authenticateTrustedProxy(req, remoteIp);
  if (proxy) {
    return finalize({
      source: 'proxy-header',
      userId: `webchat:${normalizeId(proxy.identity)}`,
      displayName: proxy.identity,
    });
  }

  // 3. Tailscale identity.
  if (TAILSCALE_ENABLED) {
    const tsUser = await tailscaleWhois(remoteIp);
    if (tsUser) {
      return finalize({
        source: 'tailscale',
        userId: `webchat:tailscale:${normalizeId(tsUser)}`,
        displayName: tsUser,
      });
    }
  }

  // 4. Localhost auto-pass — last resort, ONLY when no explicit auth method
  //    is configured. If the operator has set up bearer / tailscale / proxy
  //    auth, we must NOT trust loopback unconditionally: a fronting reverse
  //    proxy (Tailscale Serve, nginx, Caddy, oauth2-proxy, ...) terminates
  //    the public hostname and forwards to 127.0.0.1, so unauthenticated
  //    tailnet/internet traffic would otherwise bypass auth and be granted
  //    owner. With explicit auth configured, the proxy must surface the
  //    upstream identity via headers / token / tailscale whois.
  if (isLocalhost(remoteIp) && !hasExplicitAuth()) {
    const localUser = process.env.USER || process.env.USERNAME || 'user';
    return finalize({ source: 'localhost', userId: 'webchat:local-owner', displayName: localUser });
  }

  return { ok: false, reason: 'Unauthorized' };
}

/** True when the configured network mode requires at least one explicit auth method. */
export function requiresExplicitAuth(host: string): boolean {
  return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
}

/** True when at least one non-localhost auth method is configured. */
export function hasExplicitAuth(): boolean {
  return Boolean(WEBCHAT_TOKEN) || TAILSCALE_ENABLED || TRUSTED_PROXY_RAW.length > 0;
}

/**
 * Minimum bearer-token length. Operators sometimes pick a short or memorable
 * value; combined with no rate-limiting (deferred to an upstream module),
 * that's brute-forceable. 24 chars matches the entropy of a base64-encoded
 * 16-byte secret, the floor for an "actually random" token.
 */
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

/** Emit a startup warning if "auto" proxy mode is on — headers aren't verified. */
export function warnIfAutoProxyTrust(): void {
  if (TRUSTED_PROXY_RAW === 'auto') {
    log.warn(
      'Webchat: WEBCHAT_TRUSTED_PROXY_IPS=auto — headers are NOT cryptographically verified. ' +
        'Ensure this server is ONLY reachable through your proxy (Azure/Cloudflare). ' +
        'Direct access allows header forgery. Use explicit IP/CIDR for defense-in-depth.',
    );
  }
}

// ── Internals ─────────────────────────────────────────────────────────────

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

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function isIpInCidr(ip: string, cidr: string): boolean {
  const [network, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(network) & mask);
}

function isTrustedProxyIp(ip: string): boolean {
  for (const entry of TRUSTED_PROXY_ENTRIES) {
    if (entry.includes('/')) {
      if (isIpInCidr(ip, entry)) return true;
    } else {
      if (ip === entry) return true;
    }
  }
  return false;
}

function authenticateTrustedProxy(req: IncomingMessage, remoteIp: string): { identity: string } | null {
  const cleanIp = remoteIp.replace(/^::ffff:/, '');

  if (TRUST_ANY_PLATFORM) {
    // First try platform-managed headers (paired identity + signed proof).
    for (const ph of PLATFORM_HEADERS) {
      const identity = req.headers[ph.identity];
      const proof = req.headers[ph.verify];
      if (identity && proof) {
        const user = Array.isArray(identity) ? identity[0] : identity;
        if (typeof user === 'string') {
          log.debug('Webchat platform proxy auth', { identity: user, platform: ph.name });
          return { identity: user };
        }
      }
    }
    // Fall back to the configured header from any source.
    const rawUser = req.headers[TRUSTED_PROXY_HEADER];
    const user = Array.isArray(rawUser) ? rawUser[0] : rawUser;
    if (typeof user === 'string' && user) {
      log.debug('Webchat trusted proxy auth (auto fallback)', { identity: user, remoteIp: cleanIp });
      return { identity: user };
    }
    return null;
  }

  if (TRUSTED_PROXY_ENTRIES.length === 0) return null;
  if (!isTrustedProxyIp(cleanIp)) return null;
  const rawUser = req.headers[TRUSTED_PROXY_HEADER];
  const user = Array.isArray(rawUser) ? rawUser[0] : rawUser;
  if (typeof user !== 'string' || !user) return null;
  log.debug('Webchat trusted proxy auth', { identity: user, remoteIp: cleanIp });
  return { identity: user };
}

async function tailscaleWhois(ip: string): Promise<string | null> {
  const cleanIp = ip.replace(/^::ffff:/, '');
  return new Promise((resolve) => {
    execFile('tailscale', ['whois', '--json', cleanIp], { timeout: 3000 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      try {
        const data = JSON.parse(stdout) as {
          UserProfile?: { LoginName?: string };
          Node?: { Hostinfo?: { Hostname?: string } };
        };
        resolve(data?.UserProfile?.LoginName || data?.Node?.Hostinfo?.Hostname || null);
      } catch {
        resolve(null);
      }
    });
  });
}

function normalizeId(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9._@+-]/g, '-');
}

function finalize(args: { source: AuthResult['source']; userId: string; displayName: string }): AuthResult {
  // Upsert the users row so every authenticated identity is visible in the
  // Permissions UI even before any role is granted. The display_name is
  // refreshed on each connect (upsert preserves null with COALESCE if the
  // adapter doesn't have one).
  //
  // Guarded behind hasTable so a deployment without the permissions module
  // still authenticates instead of throwing on a missing FK.
  if (hasTable(getDb(), 'users')) {
    try {
      upsertUser({
        id: args.userId,
        kind: 'webchat',
        display_name: args.displayName || null,
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      log.warn('Webchat: upsertUser failed during auth finalize', { userId: args.userId, err });
    }
  }
  ensureOwnerRoleOnFirstLogin(args.userId);
  return { ok: true, userId: args.userId, displayName: args.displayName, source: args.source };
}
