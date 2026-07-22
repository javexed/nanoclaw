/**
 * Async skill-draft Keep (POST /api/skill-drafts/:id/keep).
 *
 * The overlap review is slow (optionally LLM-backed), so a plain Keep is
 * server-async: the route validates everything it always validated — draft
 * pending, CSRF, admin over the draft's group AND the target group — then
 * answers 202 { queued: true } and runs the review in the background,
 * pushing the outcome to the pressing user as a `skill_draft_review` WS
 * event. force / updateTarget skip the review and stay synchronous.
 *
 * The overlap module is mocked with a controllable impl so the background
 * job is deterministic (its own heuristics are covered in overlap.test.ts).
 * WS outcomes are captured via a stub client registered in state.ts.
 *
 * Same boot pattern as scoped-skill-auth.test.ts: identity per request via a
 * trusted proxy header.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { WebchatServer } from './server.js';

const ctl = vi.hoisted(() => ({
  impl: (async () => []) as () => Promise<unknown[]>,
  calls: 0,
}));

vi.mock('../../modules/learning/overlap.js', () => ({
  findKeepOverlaps: () => {
    ctl.calls++;
    return ctl.impl();
  },
}));

const noopHooks = { onInbound: vi.fn(), onAction: vi.fn() };

const AG_A = 'ag-keep-async-a';
const AG_B = 'ag-keep-async-b';
const DRAFT = 'draft-keep-async-1';

beforeEach(() => {
  vi.resetModules();
  ctl.impl = async () => [];
  ctl.calls = 0;
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
  // Drafts + kept skills land under the real DATA_DIR (cwd/data) — remove
  // exactly what these tests can create.
  fs.rmSync(path.join(process.cwd(), 'data', 'skill-drafts', DRAFT), { recursive: true, force: true });
  fs.rmSync(path.join(process.cwd(), 'data', 'skill-drafts', `${DRAFT}-twin`), { recursive: true, force: true });
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
  path0: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string }> {
  const http = await import('http');
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: path0, method, headers }, (res) => {
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

const now = '2026-07-21T00:00:00.000Z';
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
  group(AG_A);
  group(AG_B);
  role('webchat:owner', 'owner', null);
  role('webchat:admina', 'admin', AG_A); // scoped admin of A only
  role('webchat:adminb', 'admin', AG_B); // scoped admin of B only
}

async function stageDraft(id: string, agentGroupId: string, name: string, desc: string): Promise<void> {
  const drafts = await import('../../db/skill-drafts.js');
  drafts.createSkillDraft({
    id,
    agent_group_id: agentGroupId,
    session_id: null,
    kind: 'create',
    skill_name: name,
    target_skill: null,
    description: desc,
    body: `---\nname: ${name}\ndescription: ${desc}\n---\nTest body`,
  });
}

const KEEP = (id: string, qs = '') => `/api/skill-drafts/${id}/keep${qs}`;
const asUser = (name: string) => ({
  'x-forwarded-user': name,
  'content-type': 'application/json',
  'x-webchat-csrf': '1',
});
const bodyFor = (group: string) => JSON.stringify({ agentGroupId: group });

describe('POST /api/skill-drafts/:id/keep — async review', () => {
  let server: Awaited<ReturnType<typeof loadServerWithEnv>>['server'];
  let state: typeof import('./state.js');
  let wc: WebchatServer;
  let port: number;
  let sent: Array<Record<string, unknown>>;

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
    await stageDraft(DRAFT, AG_A, 'zz-async-keep-test', 'unique async keep test skill zz');
    wc = await server.startWebchatServer(noopHooks);
    port = portOf(wc);
    // Stub WS client for webchat:owner so pushToUser outcomes are observable.
    state = await import('./state.js');
    sent = [];
    state.addClient({
      id: 'test-ws-owner',
      ws: { readyState: 1, send: (p: string) => sent.push(JSON.parse(p) as Record<string, unknown>) } as never,
      identity: 'owner',
      identity_type: 'user',
      userId: 'webchat:owner',
      isAlive: true,
    });
  });

  afterEach(async () => {
    state.removeClient('test-ws-owner');
    if (wc) await server.stopWebchatServer(wc);
  });

  // ── Auth — preserved exactly from the sync route ──────────────────────

  it('404 for an unknown draft', async () => {
    const r = await httpRequest(port, 'POST', KEEP('nope'), asUser('owner'), bodyFor(AG_A));
    expect(r.status).toBe(404);
  });

  it('403 without the CSRF header, even for the owner', async () => {
    const headers = { 'x-forwarded-user': 'owner', 'content-type': 'application/json' };
    const r = await httpRequest(port, 'POST', KEEP(DRAFT), headers, bodyFor(AG_A));
    expect(r.status).toBe(403);
    expect(ctl.calls).toBe(0); // refused before any review
  });

  it("403 for an admin who does not administer the DRAFT's group", async () => {
    const r = await httpRequest(port, 'POST', KEEP(DRAFT), asUser('adminb'), bodyFor(AG_B));
    expect(r.status).toBe(403);
    expect(ctl.calls).toBe(0);
  });

  it("403 for an admin of the draft's group who does not administer the TARGET group", async () => {
    const r = await httpRequest(port, 'POST', KEEP(DRAFT), asUser('admina'), bodyFor(AG_B));
    expect(r.status).toBe(403);
    expect(ctl.calls).toBe(0);
  });

  it('404 for an unknown target group (checked before the review is queued)', async () => {
    const r = await httpRequest(port, 'POST', KEEP(DRAFT), asUser('owner'), bodyFor('ag-nope'));
    expect(r.status).toBe(404);
    expect(ctl.calls).toBe(0);
  });

  // ── Async plumbing ────────────────────────────────────────────────────

  it('202 { queued: true }, then a kept outcome pushed over the WS and the draft applied', async () => {
    const r = await httpRequest(port, 'POST', KEEP(DRAFT), asUser('owner'), bodyFor(AG_A));
    expect(r.status).toBe(202);
    expect(JSON.parse(r.body)).toEqual({ queued: true });

    await server.keepReviewJobFor(DRAFT); // undefined (already done) or the in-flight job
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));

    const msg = sent[0];
    expect(msg.type).toBe('skill_draft_review');
    expect(msg.draftId).toBe(DRAFT);
    expect(msg.outcome).toBe('kept');
    expect(msg.name).toBe('zz-async-keep-test');
    expect(msg.agentGroupId).toBe(AG_A);
    // The draft is resolved and the scoped skill written — same write path as before.
    const drafts = await import('../../db/skill-drafts.js');
    expect(drafts.getSkillDraft(DRAFT)).toBeUndefined();
    const kept = path.join(
      process.cwd(),
      'data',
      'v2-sessions',
      AG_A,
      '.claude-shared',
      'skills',
      'zz-async-keep-test',
      'SKILL.md',
    );
    expect(fs.existsSync(kept)).toBe(true);
  });

  it('overlaps found → WS carries them and the draft STAYS pending for the re-drive', async () => {
    ctl.impl = async () => [{ name: 'existing-twin', source: 'scoped', reason: 'same job', description: '', score: 1 }];
    const r = await httpRequest(port, 'POST', KEEP(DRAFT), asUser('owner'), bodyFor(AG_A));
    expect(r.status).toBe(202);

    await server.keepReviewJobFor(DRAFT);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));

    const msg = sent[0];
    expect(msg.outcome).toBe('overlaps');
    expect(msg.overlaps).toEqual([{ name: 'existing-twin', source: 'scoped', reason: 'same job' }]);
    const drafts = await import('../../db/skill-drafts.js');
    expect(drafts.getSkillDraft(DRAFT)?.status).toBe('pending');
  });

  it('refuses a same-draft double keep (409) while the review is in flight', async () => {
    let release!: () => void;
    ctl.impl = () =>
      new Promise((res) => {
        release = () => res([]);
      });
    const first = await httpRequest(port, 'POST', KEEP(DRAFT), asUser('owner'), bodyFor(AG_A));
    expect(first.status).toBe(202);
    const second = await httpRequest(port, 'POST', KEEP(DRAFT), asUser('owner'), bodyFor(AG_A));
    expect(second.status).toBe(409);

    const job = server.keepReviewJobFor(DRAFT);
    expect(job).toBeDefined();
    release();
    await job;
    // Job finished + map cleared — outcome was pushed.
    expect(server.keepReviewJobFor(DRAFT)).toBeUndefined();
    await vi.waitFor(() => expect(sent.length).toBe(1));
  });

  it('force=1 skips the review entirely and stays synchronous (200 + applied)', async () => {
    const r = await httpRequest(port, 'POST', KEEP(DRAFT, '?force=1'), asUser('owner'), bodyFor(AG_A));
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as { ok: boolean; name: string };
    expect(body.ok).toBe(true);
    expect(body.name).toBe('zz-async-keep-test');
    expect(ctl.calls).toBe(0); // review never consulted
    const drafts = await import('../../db/skill-drafts.js');
    expect(drafts.getSkillDraft(DRAFT)).toBeUndefined();
  });

  it('a concurrently-discarded draft yields an error outcome, not a keep', async () => {
    let release!: () => void;
    ctl.impl = () =>
      new Promise((res) => {
        release = () => res([]);
      });
    const r = await httpRequest(port, 'POST', KEEP(DRAFT), asUser('owner'), bodyFor(AG_A));
    expect(r.status).toBe(202);
    // Discard while the review is parked — the job re-fetches and bails.
    const drafts = await import('../../db/skill-drafts.js');
    drafts.resolveSkillDraft(DRAFT, 'discarded');
    const job = server.keepReviewJobFor(DRAFT);
    release();
    await job;
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    expect(sent[0].outcome).toBe('error');
  });
});
