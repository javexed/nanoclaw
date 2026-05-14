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
});
