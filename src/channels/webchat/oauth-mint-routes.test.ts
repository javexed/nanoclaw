/**
 * Pins the user-credentials OAuth-mint route paths against what app.js actually
 * calls. These two route tables were renamed out of lockstep once already (server
 * kept the pre-rename `/api/userCreds/...` prefix while the client moved to
 * `/api/user-credentials/...`), which 404'd "connect to claude"/"connect to
 * ChatGPT" for every user until caught manually. Extracting the URLs straight out
 * of app.js (rather than hardcoding a second copy here) means any future rename
 * on either side — client or server — turns this test red instead of silently
 * drifting again.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const noopHooks = { onInbound: vi.fn(), onAction: vi.fn() };
const LOCAL_OWNER = 'webchat:local-owner';

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

async function boot() {
  vi.stubEnv('WEBCHAT_HOST', '127.0.0.1');
  vi.stubEnv('WEBCHAT_PORT', '0');
  vi.stubEnv('WEBCHAT_TOKEN', '');
  vi.stubEnv('WEBCHAT_TAILSCALE', '');
  vi.stubEnv('WEBCHAT_TRUSTED_PROXY_IPS', '');
  vi.resetModules();
  const conn = await import('../../db/connection.js');
  conn.initTestDb();
  const migrations = await import('../../db/migrations/index.js');
  migrations.runMigrations(conn.getDb());

  const dbh = conn.getDb();
  const now = new Date().toISOString();
  dbh
    .prepare(
      `INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`,
    )
    .run('ag-1', 'Agent', 'agent', now);
  dbh
    .prepare(
      `INSERT OR IGNORE INTO messaging_groups (id, channel_type, instance, platform_id, name, is_group, unknown_sender_policy, created_at)
       VALUES ('room-1', 'webchat', 'webchat', 'room-1', 'Room', 0, 'public', ?)`,
    )
    .run(now);
  dbh
    .prepare(
      `INSERT OR IGNORE INTO messaging_group_agents
         (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern,
          sender_scope, ignored_message_policy, session_mode, priority, created_at)
       VALUES (?, 'room-1', 'ag-1', 'pattern', '.', 'all', 'drop', 'shared', 0, ?)`,
    )
    .run(randomUUID(), now);
  dbh
    .prepare(`INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'webchat', NULL, ?)`)
    .run(LOCAL_OWNER, now);
  dbh
    .prepare(
      `INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'owner', NULL, NULL, ?)`,
    )
    .run(LOCAL_OWNER, now);

  const server = await import('./server.js');
  const wc = await server.startWebchatServer(noopHooks);
  return { server, wc };
}

function port(wc: { http: { address: () => unknown } }): number {
  const addr = wc.http.address() as { port: number } | null;
  if (!addr) throw new Error('server has no address');
  return addr.port;
}

const CSRF = { 'content-type': 'application/json', 'x-webchat-csrf': '1' };

// Pull the literal mint-route URLs straight out of app.js, same source the browser
// runs, so this test can't itself drift from what the client calls.
const appJsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../public/webchat/app.js');
const appJs = fs.readFileSync(appJsPath, 'utf8');

function extractUrl(varName: string): string {
  const m = appJs.match(new RegExp(`const ${varName} = [^;]*'(/api/user-credentials/[a-z/-]+)'`));
  if (!m) throw new Error(`app.js: could not find a literal URL assigned to ${varName}`);
  return m[1];
}

const claudeStartUrl = extractUrl('startUrl'); // non-Codex branch, checked below
const codexCancelUrl = extractUrl('cancelUrl'); // codex branch, checked below

describe('user-credentials OAuth-mint routes — client/server path parity', () => {
  it('app.js still points at /api/user-credentials/oauth/* and /api/user-credentials/codex/*', () => {
    // Sanity on the extraction itself: both known branches must resolve, and to
    // the expected prefixes — guards against the regex silently matching nothing.
    expect(claudeStartUrl).toBe('/api/user-credentials/oauth/start');
    expect(codexCancelUrl).toMatch(/^\/api\/user-credentials\/(oauth|codex)\/cancel$/);
  });

  it('server recognizes the Claude oauth/start path (not a 404 fall-through)', async () => {
    const { server, wc } = await boot();
    try {
      const res = await fetch(`http://127.0.0.1:${port(wc)}${claudeStartUrl}`, {
        method: 'POST',
        headers: CSRF,
        body: JSON.stringify({ roomId: 'room-1' }),
      });
      const body = (await res.json()) as { error?: string };
      // Not installed/allowed by default — but that's the oauth-opt-in gate, proof
      // the route matched and was evaluated, not the "Not found" route fall-through.
      expect(res.status).toBe(403);
      expect(body.error).toMatch(/does not accept/i);
    } finally {
      await server.stopWebchatServer(wc);
    }
  });

  it('server recognizes the Codex oauth/start path (not a 404 fall-through)', async () => {
    const { server, wc } = await boot();
    try {
      const res = await fetch(`http://127.0.0.1:${port(wc)}/api/user-credentials/codex/start`, {
        method: 'POST',
        headers: CSRF,
        body: JSON.stringify({ roomId: 'room-1' }),
      });
      const body = (await res.json()) as { error?: string };
      expect(res.status).toBe(403);
      expect(body.error).toMatch(/does not accept/i);
    } finally {
      await server.stopWebchatServer(wc);
    }
  });

  it('the stale pre-rename /api/userCreds/* prefix is gone (would silently un-fix this bug)', async () => {
    const { server, wc } = await boot();
    try {
      const res = await fetch(`http://127.0.0.1:${port(wc)}/api/userCreds/oauth/start`, {
        method: 'POST',
        headers: CSRF,
        body: JSON.stringify({ roomId: 'room-1' }),
      });
      const body = (await res.json()) as { error?: string };
      expect(res.status).toBe(404);
      expect(body.error).toBe('Not found');
    } finally {
      await server.stopWebchatServer(wc);
    }
  });
});
