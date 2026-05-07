/**
 * Overview-endpoint tests — verifies the `/api/overview` response shape,
 * owner-vs-admin graceful degrade, and the basic count math (agents,
 * sessions, 24h messages, channels).
 *
 * Boots the server on an ephemeral port for each scenario so the env-var
 * gates (auth mode, token strength) are honoured the same way they would
 * be in production.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';

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

async function bootLocalhost() {
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
  const server = await import('./server.js');
  const wc = await server.startWebchatServer(noopHooks);
  return { server, wc, conn };
}

function port(wc: { http: { address: () => unknown } }): number {
  const addr = wc.http.address() as { port: number } | null;
  if (!addr) throw new Error('server has no address');
  return addr.port;
}

async function getOverview(wc: {
  http: { address: () => unknown };
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port(wc)}/api/overview`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('GET /api/overview — owner (loopback no-auth path)', () => {
  it('returns the full snapshot shape', async () => {
    const { server, wc } = await bootLocalhost();
    try {
      const { status, body } = await getOverview(wc);
      expect(status).toBe(200);
      // restricted=false on the owner path — loopback bypass with no
      // permissions module degrades to "trust authenticated" → owner.
      expect(body).toMatchObject({
        restricted: false,
        agents: expect.objectContaining({ total: expect.any(Number), visible: expect.any(Number) }),
        sessions: expect.objectContaining({ active: expect.any(Number), total: expect.any(Number) }),
        messages: expect.objectContaining({ webchat_24h: expect.any(Number) }),
        channels: expect.any(Object),
        recent_agents: expect.any(Array),
      });
      // System metrics only present for owner.
      expect(body.system).toBeTruthy();
    } finally {
      await server.stopWebchatServer(wc);
    }
  });

  it('counts agents and channel wirings correctly', async () => {
    const { server, wc, conn } = await bootLocalhost();
    try {
      const db = conn.getDb();
      // Seed 2 agents + 2 webchat rooms + 1 wiring.
      const now = new Date().toISOString();
      const agentA = randomUUID();
      const agentB = randomUUID();
      db.prepare(
        `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`,
      ).run(agentA, 'Alpha', 'alpha', now);
      db.prepare(
        `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`,
      ).run(agentB, 'Beta', 'beta', now);
      const mgA = randomUUID();
      db.prepare(
        `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
         VALUES (?, 'webchat', 'alpha', 'Alpha', 1, 'public', ?)`,
      ).run(mgA, now);
      db.prepare(
        `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
         VALUES (?, 'whatsapp', '1234@g.us', 'Group', 1, 'public', ?)`,
      ).run(randomUUID(), now);
      db.prepare(
        `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, ignored_message_policy, session_mode, priority, created_at)
         VALUES (?, ?, ?, 'pattern', '.', 'all', 'drop', 'shared', 0, ?)`,
      ).run(randomUUID(), mgA, agentA, now);

      const { body } = await getOverview(wc);
      expect(body.agents).toMatchObject({ total: 2, visible: 2 });
      expect(body.channels).toEqual({ webchat: 1, whatsapp: 1 });
      expect((body.recent_agents as Array<{ name: string }>).map((a) => a.name).sort()).toEqual(['Alpha', 'Beta']);
    } finally {
      await server.stopWebchatServer(wc);
    }
  });

  it('counts webchat messages in the last 24 hours, not older ones', async () => {
    const { server, wc, conn } = await bootLocalhost();
    try {
      const db = conn.getDb();
      const now = new Date().toISOString();
      // Seed a room first.
      db.prepare(
        `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
         VALUES (?, 'webchat', 'r1', 'R1', 1, 'public', ?)`,
      ).run(randomUUID(), now);
      // 3 messages in the last hour, 1 from 25 hours ago.
      const recent = Date.now();
      const old = Date.now() - 25 * 3600 * 1000;
      const insertMsg = db.prepare(
        `INSERT INTO webchat_messages (id, room_id, sender, sender_type, content, message_type, file_meta, created_at)
         VALUES (?, 'r1', 'alice', 'user', ?, 'text', NULL, ?)`,
      );
      insertMsg.run(randomUUID(), 'hi', recent);
      insertMsg.run(randomUUID(), 'hello', recent);
      insertMsg.run(randomUUID(), 'yo', recent);
      insertMsg.run(randomUUID(), 'old', old);

      const { body } = await getOverview(wc);
      expect((body.messages as { webchat_24h: number }).webchat_24h).toBe(3);
      const busiest = body.busiest_rooms as Array<{ id: string; count: number }>;
      expect(busiest).toHaveLength(1);
      expect(busiest[0]).toMatchObject({ id: 'r1', count: 3 });
    } finally {
      await server.stopWebchatServer(wc);
    }
  });

  it('counts active sessions by last_active within the 5-minute window', async () => {
    const { server, wc, conn } = await bootLocalhost();
    try {
      const db = conn.getDb();
      const now = new Date().toISOString();
      const agentId = randomUUID();
      db.prepare(
        `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, 'A', 'a', NULL, ?)`,
      ).run(agentId, now);
      // 1 active session, 1 idle session.
      const active = new Date(Date.now() - 60_000).toISOString();
      const idle = new Date(Date.now() - 10 * 60_000).toISOString();
      db.prepare(
        `INSERT INTO sessions (id, agent_group_id, status, last_active, created_at) VALUES (?, ?, 'active', ?, ?)`,
      ).run('sess-active', agentId, active, now);
      db.prepare(
        `INSERT INTO sessions (id, agent_group_id, status, last_active, created_at) VALUES (?, ?, 'active', ?, ?)`,
      ).run('sess-idle', agentId, idle, now);

      const { body } = await getOverview(wc);
      expect(body.sessions).toMatchObject({ active: 1, total: 2 });
    } finally {
      await server.stopWebchatServer(wc);
    }
  });
});
