/**
 * Boot-gate tests — verifies the server's two startup refusals:
 *   1. Bind to non-loopback host with no auth method configured.
 *   2. Bearer token shorter than the minimum length (Batch 1).
 *
 * Each scenario boots the server module against its own env snapshot, then
 * tears down — same `vi.resetModules()` pattern as auth.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const noopHooks = { onInbound: vi.fn(), onAction: vi.fn() };

beforeEach(() => {
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  try {
    const conn = await import('../../db/connection.js');
    conn.closeDb();
  } catch {
    // ignore
  }
  vi.resetModules();
});

async function loadServerWithEnv(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) vi.stubEnv(k, '');
    else vi.stubEnv(k, v);
  }
  vi.resetModules();
  const conn = await import('../../db/connection.js');
  conn.initTestDb();
  const migrations = await import('../../db/migrations/index.js');
  migrations.runMigrations(conn.getDb());
  return await import('./server.js');
}

async function httpRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string }> {
  const http = await import('http');
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: buf }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const portOf = (wc: { http: { address: () => unknown } }): number => {
  const a = wc.http.address();
  return typeof a === 'object' && a ? (a as { port: number }).port : 0;
};

describe('startWebchatServer — boot gate', () => {
  it('refuses to bind to 0.0.0.0 without any explicit auth', async () => {
    const server = await loadServerWithEnv({
      WEBCHAT_HOST: '0.0.0.0',
      WEBCHAT_PORT: '0', // ephemeral; would have bound but we expect throw first
      WEBCHAT_TOKEN: '',
      WEBCHAT_TAILSCALE: '',
      WEBCHAT_TRUSTED_PROXY_IPS: '',
    });
    await expect(server.startWebchatServer(noopHooks)).rejects.toThrow(/no auth method configured/i);
  });

  it('refuses to start with a bearer token shorter than 24 chars', async () => {
    const server = await loadServerWithEnv({
      WEBCHAT_HOST: '127.0.0.1',
      WEBCHAT_PORT: '0',
      WEBCHAT_TOKEN: 'short',
    });
    await expect(server.startWebchatServer(noopHooks)).rejects.toThrow(/at least 24/);
  });

  it('starts on loopback with no auth (the legitimate localhost case)', async () => {
    const server = await loadServerWithEnv({
      WEBCHAT_HOST: '127.0.0.1',
      WEBCHAT_PORT: '0',
      WEBCHAT_TOKEN: '',
    });
    const wc = await server.startWebchatServer(noopHooks);
    try {
      expect(wc.host).toBe('127.0.0.1');
      // Server stores the configured port (0 = ephemeral); resolution to a
      // bound port lives on the underlying http server's address(). The
      // important assertion is that startWebchatServer resolved at all.
      expect(wc.http.listening).toBe(true);
    } finally {
      await server.stopWebchatServer(wc);
    }
  });

  it('starts on 0.0.0.0 with a strong bearer token', async () => {
    const server = await loadServerWithEnv({
      WEBCHAT_HOST: '0.0.0.0',
      WEBCHAT_PORT: '0',
      WEBCHAT_TOKEN: 'a'.repeat(32),
    });
    const wc = await server.startWebchatServer(noopHooks);
    try {
      expect(wc.host).toBe('0.0.0.0');
    } finally {
      await server.stopWebchatServer(wc);
    }
  });

  it('sets CSP + nosniff + frame headers on every response', async () => {
    const http = await import('http');
    const server = await loadServerWithEnv({ WEBCHAT_HOST: '127.0.0.1', WEBCHAT_PORT: '0', WEBCHAT_TOKEN: '' });
    const wc = await server.startWebchatServer(noopHooks);
    try {
      const addr = wc.http.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const headers = await new Promise<Record<string, string | string[] | undefined>>((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (res) => {
          res.resume();
          resolve(res.headers);
        });
        r.on('error', reject);
        r.end();
      });
      const csp = String(headers['content-security-policy'] ?? '');
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'"); // the load-bearing XSS guard
      expect(csp).toContain("object-src 'none'");
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['x-frame-options']).toBe('DENY');
    } finally {
      await server.stopWebchatServer(wc);
    }
  });

  it('serves the PWA shell (login screen) pre-auth while still gating data endpoints', async () => {
    // Token-only deployment (0.0.0.0 + bearer, no localhost auto-pass): the app
    // shell must load so the user can reach the token field, but /api/* stays
    // gated. Regression guard for the chicken-and-egg where static was 401'd.
    const http = await import('http');
    const server = await loadServerWithEnv({
      WEBCHAT_HOST: '0.0.0.0',
      WEBCHAT_PORT: '0',
      WEBCHAT_TOKEN: 'a'.repeat(32),
    });
    const wc = await server.startWebchatServer(noopHooks);
    try {
      const addr = wc.http.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const get = (p: string) =>
        new Promise<{ status: number; body: string; type: string }>((resolve, reject) => {
          const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, body, type: String(res.headers['content-type'] ?? '') }),
            );
          });
          r.on('error', reject);
          r.end();
        });
      // index.html shell is reachable WITHOUT a token (it holds the login form)…
      const index = await get('/');
      expect(index.status).toBe(200);
      expect(index.type).toContain('text/html');
      // …but data endpoints still demand the token even from loopback (a bearer
      // method is configured, so localhost does not auto-pass).
      const gated = await get('/api/overview');
      expect(gated.status).toBe(401);
      expect(JSON.parse(gated.body)).toMatchObject({ error: 'Unauthorized' });
    } finally {
      await server.stopWebchatServer(wc);
    }
  });

  it('refuses to disable the bearer token when no alternative auth method is live', async () => {
    const TOKEN = 'a'.repeat(32);
    const server = await loadServerWithEnv({ WEBCHAT_HOST: '0.0.0.0', WEBCHAT_PORT: '0', WEBCHAT_TOKEN: TOKEN });
    const wc = await server.startWebchatServer(noopHooks);
    try {
      const port = portOf(wc);
      const res = await httpRequest(
        port,
        'PUT',
        '/api/webchat/auth/bearer',
        { Authorization: `Bearer ${TOKEN}`, 'X-Webchat-CSRF': '1', 'Content-Type': 'application/json' },
        JSON.stringify({ active: false }),
      );
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/Tailscale|SSO|trusted-proxy/i);
      // The token must still authenticate — nothing was disabled.
      const check = await httpRequest(port, 'GET', '/api/auth/check', { Authorization: `Bearer ${TOKEN}` });
      expect(check.status).toBe(200);
    } finally {
      await server.stopWebchatServer(wc);
    }
  });

  it('marketplace toggle gates MCP + skills endpoints (default on, owner disables)', async () => {
    const TOKEN = 'a'.repeat(32);
    const server = await loadServerWithEnv({ WEBCHAT_HOST: '0.0.0.0', WEBCHAT_PORT: '0', WEBCHAT_TOKEN: TOKEN });
    const wc = await server.startWebchatServer(noopHooks);
    try {
      const port = portOf(wc);
      const auth = { Authorization: `Bearer ${TOKEN}` };
      const csrf = { ...auth, 'X-Webchat-CSRF': '1', 'Content-Type': 'application/json' };
      // Default: enabled, owner can edit.
      const f0 = await httpRequest(port, 'GET', '/api/webchat/features', auth);
      expect(f0.status).toBe(200);
      expect(JSON.parse(f0.body)).toMatchObject({ marketplaceEnabled: true, canEdit: true });
      // Owner disables it.
      const put = await httpRequest(
        port,
        'PUT',
        '/api/webchat/features',
        csrf,
        JSON.stringify({ marketplaceEnabled: false }),
      );
      expect(put.status).toBe(200);
      expect(JSON.parse(put.body).marketplaceEnabled).toBe(false);
      // Both surfaces now 403 with the marketplace message.
      const skills = await httpRequest(port, 'GET', '/api/skills', auth);
      expect(skills.status).toBe(403);
      expect(JSON.parse(skills.body).error).toMatch(/marketplace/i);
      const mcp = await httpRequest(port, 'GET', '/api/mcp-servers', auth);
      expect(mcp.status).toBe(403);
      // Re-enable → the marketplace gate clears.
      await httpRequest(port, 'PUT', '/api/webchat/features', csrf, JSON.stringify({ marketplaceEnabled: true }));
      const skills2 = await httpRequest(port, 'GET', '/api/skills', auth);
      expect(skills2.status).not.toBe(403);
    } finally {
      await server.stopWebchatServer(wc);
    }
  });

  it('arms/reads the first-tailscale-owner flag (owner only)', async () => {
    const TOKEN = 'a'.repeat(32);
    const server = await loadServerWithEnv({ WEBCHAT_HOST: '0.0.0.0', WEBCHAT_PORT: '0', WEBCHAT_TOKEN: TOKEN });
    const wc = await server.startWebchatServer(noopHooks);
    try {
      const port = portOf(wc);
      const auth = { Authorization: `Bearer ${TOKEN}` };
      const csrf = { ...auth, 'X-Webchat-CSRF': '1', 'Content-Type': 'application/json' };
      const g0 = await httpRequest(port, 'GET', '/api/webchat/tailscale-owner', auth);
      expect(g0.status).toBe(200);
      expect(JSON.parse(g0.body)).toMatchObject({ armed: false, canEdit: true });
      const put = await httpRequest(port, 'PUT', '/api/webchat/tailscale-owner', csrf, JSON.stringify({ armed: true }));
      expect(put.status).toBe(200);
      expect(JSON.parse(put.body).armed).toBe(true);
      const g1 = await httpRequest(port, 'GET', '/api/webchat/tailscale-owner', auth);
      expect(JSON.parse(g1.body).armed).toBe(true);
    } finally {
      await server.stopWebchatServer(wc);
    }
  });

  it('exposes tailscale-serve state to owner (GET) and CSRF-gates the enable action', async () => {
    const TOKEN = 'a'.repeat(32);
    const server = await loadServerWithEnv({ WEBCHAT_HOST: '0.0.0.0', WEBCHAT_PORT: '0', WEBCHAT_TOKEN: TOKEN });
    const wc = await server.startWebchatServer(noopHooks);
    try {
      const port = portOf(wc);
      const auth = { Authorization: `Bearer ${TOKEN}` };
      // GET is read-only (`tailscale status`) — safe regardless of whether a
      // daemon is present. Assert the shape, not machine-dependent values.
      const g = await httpRequest(port, 'GET', '/api/webchat/tailscale-https', auth);
      expect(g.status).toBe(200);
      expect(typeof JSON.parse(g.body).available).toBe('boolean');
      // POST without the CSRF header is refused BEFORE any `tailscale serve`
      // runs — deliberately no CSRF'd POST here so the test never mutates real
      // serve config; the enable paths are covered in tailscale-serve.test.ts.
      const p = await httpRequest(port, 'POST', '/api/webchat/tailscale-https', auth);
      expect(p.status).toBe(403);
    } finally {
      await server.stopWebchatServer(wc);
    }
  });

  it('disables the bearer token when a trusted-proxy method is live and used', async () => {
    const TOKEN = 'a'.repeat(32);
    const server = await loadServerWithEnv({
      WEBCHAT_HOST: '0.0.0.0',
      WEBCHAT_PORT: '0',
      WEBCHAT_TOKEN: TOKEN,
      WEBCHAT_TRUSTED_PROXY_IPS: '127.0.0.1',
      WEBCHAT_TRUSTED_PROXY_HEADER: 'x-forwarded-user',
    });
    const wc = await server.startWebchatServer(noopHooks);
    try {
      const port = portOf(wc);
      // Authenticate via the proxy header (source='proxy-header', not bearer) so
      // the self-lockout guard is satisfied and the alt method is proven usable.
      const proxyHdr = { 'x-forwarded-user': 'alice', 'X-Webchat-CSRF': '1', 'Content-Type': 'application/json' };
      const res = await httpRequest(
        port,
        'PUT',
        '/api/webchat/auth/bearer',
        proxyHdr,
        JSON.stringify({ active: false }),
      );
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).bearerActive).toBe(false);
      // The bearer token no longer authenticates…
      const withToken = await httpRequest(port, 'GET', '/api/auth/check', { Authorization: `Bearer ${TOKEN}` });
      expect(withToken.status).toBe(401);
      // …but the proxy method still does.
      const withProxy = await httpRequest(port, 'GET', '/api/auth/check', { 'x-forwarded-user': 'alice' });
      expect(withProxy.status).toBe(200);
    } finally {
      await server.stopWebchatServer(wc);
    }
  });
});
