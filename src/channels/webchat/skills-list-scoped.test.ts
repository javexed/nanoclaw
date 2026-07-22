/**
 * GET /api/skills — agent-scoped skills in the registry list.
 *
 * The pool endpoints only listed shipped + user-pool skills, so a skill wired
 * to ONE agent (learned-and-kept, or a per-agent import) never appeared on the
 * Skills page. The route now appends every scoped skill across the agents the
 * caller administers, each carrying agentGroupId + agentName + the webchat
 * rooms that agent is wired to (so the UI can pill it with a location).
 *
 * Visibility mirrors the topology / skill-drafts rule (listAgentsForUser:
 * owner → all agents, otherwise hasAdminPrivilege per group): a scoped admin
 * must never see a skill living on an agent they don't administer.
 *
 * Same boot pattern as scoped-skill-auth.test.ts: identity per request via a
 * trusted proxy header; scoped skills are real dirs under
 * data/v2-sessions/<agent>/.claude-shared/skills, removed in afterEach.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { WebchatServer } from './server.js';

const noopHooks = { onInbound: vi.fn(), onAction: vi.fn() };

const AG_A = 'ag-slist-a';
const AG_B = 'ag-slist-b';

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
  // Scoped-skill fixtures land under the real DATA_DIR (cwd/data) — remove
  // exactly what these tests can create.
  for (const g of [AG_A, AG_B]) {
    fs.rmSync(path.join(process.cwd(), 'data', 'v2-sessions', g), { recursive: true, force: true });
  }
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
  return { server: await import('./server.js'), conn };
}

async function httpRequest(
  port: number,
  method: string,
  path_: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const http = await import('http');
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: path_, method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: buf }));
    });
    r.on('error', reject);
    r.end();
  });
}

const portOf = (wc: { http: { address: () => unknown } }): number => {
  const a = wc.http.address();
  return typeof a === 'object' && a ? (a as { port: number }).port : 0;
};

const now = '2026-07-21T00:00:00.000Z';
function seed(db: import('better-sqlite3').Database): void {
  const user = (id: string) =>
    db
      .prepare(`INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'webchat', NULL, ?)`)
      .run(id, now);
  const group = (id: string, name: string) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`,
      )
      .run(id, name, id, now);
  const role = (uid: string, r: 'owner' | 'admin', g: string | null) => {
    user(uid);
    db.prepare(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, ?, NULL, ?)`,
    ).run(uid, r, g, now);
  };
  // Fresh DBs ship with the MCP/skills marketplace disabled (migration 131);
  // the /api/skills prefix gate would 403 everything otherwise.
  db.exec(`UPDATE webchat_settings SET marketplace_disabled = 0`);
  group(AG_A, 'Alpha');
  group(AG_B, 'Beta');
  // Pre-seed an owner so the first authenticated request doesn't auto-claim it.
  role('webchat:owner', 'owner', null);
  role('webchat:admina', 'admin', AG_A); // scoped admin of A only
  // Wire agent A to one webchat room, so its scoped skills carry the room.
  db.prepare(
    `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
     VALUES ('mg-slist', 'webchat', 'room-slist', 'webchat', 'Ops room', 1, 'strict', ?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, session_mode, priority, created_at)
     VALUES ('mga-slist', 'mg-slist', ?, 'shared', 0, ?)`,
  ).run(AG_A, now);
}

function writeScopedSkill(agentGroupId: string, name: string, description: string): void {
  const dir = path.join(process.cwd(), 'data', 'v2-sessions', agentGroupId, '.claude-shared', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`);
}

type SkillEntry = {
  name: string;
  description: string;
  source: string;
  agentGroupId?: string;
  agentName?: string;
  rooms?: Array<{ id: string; name: string }>;
};

describe('GET /api/skills — scoped-skill aggregation', () => {
  let server: Awaited<ReturnType<typeof loadServerWithEnv>>['server'];
  let wc: WebchatServer;
  let port: number;

  beforeEach(async () => {
    const loaded = await loadServerWithEnv({
      WEBCHAT_HOST: '127.0.0.1',
      WEBCHAT_PORT: '0',
      WEBCHAT_TOKEN: '',
      WEBCHAT_TRUSTED_PROXY_IPS: '127.0.0.1',
      WEBCHAT_TRUSTED_PROXY_HEADER: 'x-forwarded-user',
    });
    server = loaded.server;
    seed(loaded.conn.getDb());
    writeScopedSkill(AG_A, 'slist-scoped-a', 'Scoped to Alpha');
    writeScopedSkill(AG_B, 'slist-scoped-b', 'Scoped to Beta');
    wc = await server.startWebchatServer(noopHooks);
    port = portOf(wc);
  });

  afterEach(async () => {
    if (wc) await server.stopWebchatServer(wc);
  });

  const as = (name: string) => ({ 'x-forwarded-user': name });

  async function fetchSkills(userName: string): Promise<SkillEntry[]> {
    const r = await httpRequest(port, 'GET', '/api/skills', as(userName));
    expect(r.status).toBe(200);
    return (JSON.parse(r.body) as { skills: SkillEntry[] }).skills;
  }

  it('owner sees every agent-scoped skill with agent + room context', async () => {
    const skills = await fetchSkills('owner');
    const a = skills.find((s) => s.name === 'slist-scoped-a');
    expect(a).toMatchObject({
      source: 'scoped',
      description: 'Scoped to Alpha',
      agentGroupId: AG_A,
      agentName: 'Alpha',
      rooms: [{ id: 'room-slist', name: 'Ops room' }],
    });
    // Agent B is wired to no webchat room → empty rooms, still listed.
    const b = skills.find((s) => s.name === 'slist-scoped-b');
    expect(b).toMatchObject({ source: 'scoped', agentGroupId: AG_B, agentName: 'Beta', rooms: [] });
    // The shared pool is still there alongside (shipped skills from container/skills).
    expect(skills.some((s) => s.source === 'shipped')).toBe(true);
  });

  it('scoped admin sees only skills on agents they administer', async () => {
    const skills = await fetchSkills('admina');
    expect(skills.some((s) => s.name === 'slist-scoped-a')).toBe(true);
    expect(skills.some((s) => s.name === 'slist-scoped-b')).toBe(false);
  });

  it('a scoped skill shadowing a pool name does not double-appear', async () => {
    // 'welcome' ships in container/skills — a same-named real dir in an
    // agent's scoped folder must not produce a second row.
    writeScopedSkill(AG_A, 'welcome', 'Shadow copy');
    const skills = await fetchSkills('owner');
    const rows = skills.filter((s) => s.name === 'welcome');
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('shipped');
  });
});
