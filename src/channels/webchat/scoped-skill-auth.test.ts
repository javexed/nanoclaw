/**
 * Authorization tests for the per-agent scoped-skill content endpoints
 * (GET/PUT /api/agents/:id/skills/scoped/:name/content).
 *
 * The rule: a scoped skill lives in ONE agent's own dir, so a per-group admin
 * of that agent may view AND edit it — but NOT a skill on an agent they don't
 * administer (that would let them reach an agent they can't otherwise touch).
 * Owner / global admin reach any agent. Non-admins are refused outright.
 *
 * The tests never create a skill on disk — they lean on the 403-vs-404 split:
 *   403 = authorization refused (never reached the handler)
 *   404 = authorized, but that skill file doesn't exist (handler ran)
 * so a 404 proves the caller passed the gate.
 *
 * Identity is supplied per-request via a trusted proxy header, so each request
 * can act as a different user. Same boot/teardown pattern as server.auth.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { WebchatServer } from './server.js';

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
  return { server: await import('./server.js'), conn };
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

const now = '2026-07-14T00:00:00.000Z';
function seed(db: import('better-sqlite3').Database): void {
  const user = (id: string) =>
    db
      .prepare(`INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'webchat', NULL, ?)`)
      .run(id, now);
  const group = (id: string) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`,
      )
      .run(id, id, id, now);
  const role = (uid: string, r: 'owner' | 'admin', g: string | null) => {
    user(uid);
    if (g) group(g);
    db.prepare(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, ?, NULL, ?)`,
    ).run(uid, r, g, now);
  };
  group('ag-test-a');
  group('ag-test-b');
  // Pre-seed an owner so the first authenticated request doesn't auto-claim it.
  role('webchat:owner', 'owner', null);
  role('webchat:admina', 'admin', 'ag-test-a'); // scoped admin of A only
  user('webchat:nobody'); // known user, but no role anywhere
}

const SCOPED = (g: string) => `/api/agents/${g}/skills/scoped/nonexistent-skill/content`;

describe('scoped-skill content endpoints — authorization', () => {
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
    wc = await server.startWebchatServer(noopHooks);
    port = portOf(wc);
  });

  afterEach(async () => {
    if (wc) await server.stopWebchatServer(wc);
  });

  const as = (name: string) => ({ 'x-forwarded-user': name });

  it('scoped admin reaches their own agent (404 = past the gate, no such skill)', async () => {
    const r = await httpRequest(port, 'GET', SCOPED('ag-test-a'), as('admina'));
    expect(r.status).toBe(404);
  });

  it('scoped admin is refused on an agent they do NOT administer', async () => {
    const r = await httpRequest(port, 'GET', SCOPED('ag-test-b'), as('admina'));
    expect(r.status).toBe(403);
  });

  it('a non-admin user is refused', async () => {
    const r = await httpRequest(port, 'GET', SCOPED('ag-test-a'), as('nobody'));
    expect(r.status).toBe(403);
  });

  it('owner / global admin reaches any agent', async () => {
    const r = await httpRequest(port, 'GET', SCOPED('ag-test-b'), as('owner'));
    expect(r.status).toBe(404);
  });

  it('PUT without the CSRF header is refused even for the right admin', async () => {
    const r = await httpRequest(
      port,
      'PUT',
      SCOPED('ag-test-a'),
      { ...as('admina'), 'content-type': 'application/json' },
      JSON.stringify({ content: 'x' }),
    );
    expect(r.status).toBe(403);
  });

  it('PUT with CSRF by the right admin passes the gate (404 = no such skill to overwrite)', async () => {
    const r = await httpRequest(
      port,
      'PUT',
      SCOPED('ag-test-a'),
      { ...as('admina'), 'content-type': 'application/json', 'x-webchat-csrf': '1' },
      JSON.stringify({ content: '---\ndescription: test\n---\nbody' }),
    );
    expect(r.status).toBe(404);
  });

  it('PUT with CSRF on an unadministered agent is refused before any write', async () => {
    const r = await httpRequest(
      port,
      'PUT',
      SCOPED('ag-test-b'),
      { ...as('admina'), 'content-type': 'application/json', 'x-webchat-csrf': '1' },
      JSON.stringify({ content: '---\ndescription: test\n---\nbody' }),
    );
    expect(r.status).toBe(403);
  });
});
