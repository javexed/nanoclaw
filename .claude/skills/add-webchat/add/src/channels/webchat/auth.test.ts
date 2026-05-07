/**
 * Auth tests — bearer token gating, loopback auto-pass, IPv4-mapped IPv6
 * handling, trusted-proxy IP gating, and the Batch-1 minimum-token-length
 * startup gate.
 *
 * Auth.ts reads env vars at module load (`WEBCHAT_TOKEN`, `WEBCHAT_TAILSCALE`,
 * `WEBCHAT_TRUSTED_PROXY_IPS`). Tests use `vi.resetModules()` + dynamic
 * imports so each scenario boots auth.ts with its own env snapshot.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { IncomingMessage } from 'http';

// Each test resets modules to load auth.ts with a fresh env snapshot. That
// also resets the `db/connection.js` module instance, so the DB has to be
// re-initialised inside loadAuthWithEnv against the FRESH module instance —
// importing initTestDb at the top of this file gives us the wrong (already-
// closed) connection module after reset.

// Minimal IncomingMessage fake — the auth path only reads `socket.remoteAddress`
// and `headers`, so we don't need a real HTTP server.
function fakeReq(
  opts: {
    remoteAddress?: string;
    headers?: Record<string, string | string[] | undefined>;
  } = {},
): IncomingMessage {
  return {
    socket: { remoteAddress: opts.remoteAddress ?? '127.0.0.1' },
    headers: opts.headers ?? {},
  } as unknown as IncomingMessage;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  // Close whichever connection module is currently loaded, then drop the
  // module cache so the next test starts clean.
  try {
    const conn = await import('../../db/connection.js');
    conn.closeDb();
  } catch {
    // ignore
  }
  vi.resetModules();
});

async function loadAuthWithEnv(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) vi.stubEnv(k, '');
    else vi.stubEnv(k, v);
  }
  vi.resetModules();
  // Init the FRESH connection module so getDb() works inside the freshly
  // loaded auth.ts/roles.ts.
  const conn = await import('../../db/connection.js');
  conn.initTestDb();
  // permissions module is optional — without `user_roles`, role helpers
  // degrade to "trust authenticated" and don't INSERT.
  return await import('./auth.js');
}

describe('assertBearerTokenStrength', () => {
  it('passes when no token is set (other auth modes)', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TOKEN: '' });
    expect(() => auth.assertBearerTokenStrength()).not.toThrow();
  });

  it('passes for a 24-char token (the minimum)', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TOKEN: 'a'.repeat(24) });
    expect(() => auth.assertBearerTokenStrength()).not.toThrow();
  });

  it('throws for a 23-char token (just below minimum)', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TOKEN: 'a'.repeat(23) });
    expect(() => auth.assertBearerTokenStrength()).toThrow(/at least 24/);
  });

  it('throws for a trivially short token', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TOKEN: 'hunter2' });
    expect(() => auth.assertBearerTokenStrength()).toThrow();
  });
});

describe('authenticateRequest — bearer', () => {
  const TOKEN = 'a'.repeat(32);

  it('accepts a matching Authorization Bearer header', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TOKEN: TOKEN });
    const req = fakeReq({
      remoteAddress: '203.0.113.5',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const result = await auth.authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.source).toBe('bearer');
  });

  it('accepts a bearer subprotocol on the WS upgrade', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TOKEN: TOKEN });
    const req = fakeReq({
      remoteAddress: '203.0.113.5',
      headers: { 'sec-websocket-protocol': `bearer.${TOKEN}` },
    });
    const result = await auth.authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.source).toBe('bearer');
  });

  it('rejects a wrong token (timing-safe compare returns false)', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TOKEN: TOKEN });
    const req = fakeReq({
      remoteAddress: '203.0.113.5',
      headers: { authorization: `Bearer wrong-token-of-the-same-length-aaaa` },
    });
    const result = await auth.authenticateRequest(req);
    expect(result.ok).toBe(false);
  });

  it('rejects when no token sent and not on loopback', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TOKEN: TOKEN });
    const req = fakeReq({ remoteAddress: '203.0.113.5' });
    const result = await auth.authenticateRequest(req);
    expect(result.ok).toBe(false);
  });
});

describe('authenticateRequest — loopback bypass', () => {
  it('auto-passes loopback when no explicit auth is configured', async () => {
    const auth = await loadAuthWithEnv({});
    const req = fakeReq({ remoteAddress: '127.0.0.1' });
    const result = await auth.authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.source).toBe('localhost');
  });

  it('treats IPv4-mapped IPv6 (::ffff:127.0.0.1) as loopback', async () => {
    const auth = await loadAuthWithEnv({});
    const req = fakeReq({ remoteAddress: '::ffff:127.0.0.1' });
    const result = await auth.authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.source).toBe('localhost');
  });

  it('treats ::1 as loopback', async () => {
    const auth = await loadAuthWithEnv({});
    const req = fakeReq({ remoteAddress: '::1' });
    const result = await auth.authenticateRequest(req);
    expect(result.ok).toBe(true);
  });

  it('DISABLES loopback bypass when WEBCHAT_TOKEN is set', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TOKEN: 'a'.repeat(32) });
    const req = fakeReq({ remoteAddress: '127.0.0.1' });
    const result = await auth.authenticateRequest(req);
    // No bearer presented — must reject even though it's loopback.
    expect(result.ok).toBe(false);
  });

  it('DISABLES loopback bypass when tailscale is enabled', async () => {
    const auth = await loadAuthWithEnv({ WEBCHAT_TAILSCALE: 'true' });
    const req = fakeReq({ remoteAddress: '127.0.0.1' });
    const result = await auth.authenticateRequest(req);
    // Tailscale whois on 127.0.0.1 returns nothing — and loopback is disabled.
    expect(result.ok).toBe(false);
  });
});

describe('authenticateRequest — trusted proxy header', () => {
  it('accepts a header from a configured proxy IP', async () => {
    const auth = await loadAuthWithEnv({
      WEBCHAT_TRUSTED_PROXY_IPS: '10.0.0.5',
    });
    const req = fakeReq({
      remoteAddress: '10.0.0.5',
      headers: { 'x-forwarded-user': 'alice@example.com' },
    });
    const result = await auth.authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('proxy-header');
      expect(result.userId).toContain('alice');
    }
  });

  it('rejects a header from a NON-trusted source IP', async () => {
    const auth = await loadAuthWithEnv({
      WEBCHAT_TRUSTED_PROXY_IPS: '10.0.0.5',
    });
    const req = fakeReq({
      remoteAddress: '203.0.113.99',
      headers: { 'x-forwarded-user': 'attacker@example.com' },
    });
    const result = await auth.authenticateRequest(req);
    expect(result.ok).toBe(false);
  });

  it('accepts via CIDR match', async () => {
    const auth = await loadAuthWithEnv({
      WEBCHAT_TRUSTED_PROXY_IPS: '10.0.0.0/24',
    });
    const req = fakeReq({
      remoteAddress: '10.0.0.42',
      headers: { 'x-forwarded-user': 'bob@example.com' },
    });
    const result = await auth.authenticateRequest(req);
    expect(result.ok).toBe(true);
  });

  it('rejects a CIDR-out-of-range source', async () => {
    const auth = await loadAuthWithEnv({
      WEBCHAT_TRUSTED_PROXY_IPS: '10.0.0.0/24',
    });
    const req = fakeReq({
      remoteAddress: '10.0.1.1',
      headers: { 'x-forwarded-user': 'bob@example.com' },
    });
    const result = await auth.authenticateRequest(req);
    expect(result.ok).toBe(false);
  });
});
