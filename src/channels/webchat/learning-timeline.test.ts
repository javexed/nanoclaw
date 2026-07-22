/**
 * GET /api/learning/timeline — the Journey view's read-only event feed.
 *
 * The timeline is DERIVED, not stored: proposed/kept/discarded come from the
 * persisted in-room skill-draft cards (the only durable outcome record —
 * resolveSkillDraft deletes the skill_drafts row), card-less pending drafts
 * fill in non-webchat proposals, and the disk supplies revised (.history
 * snapshots), kept-without-a-card (learned-origin scoped skills) and archived
 * (curator .archive/) events.
 *
 * Covered here: response shape per event kind, the drafts-list visibility rule
 * (owner sees all, a scoped admin only their groups), and cursor pagination —
 * including the tie-at-the-boundary case (a kept dated by its first revision
 * shares that revision's ts and must not be lost between pages).
 *
 * Same boot pattern as skills-list-scoped.test.ts.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { WebchatServer } from './server.js';

const noopHooks = { onInbound: vi.fn(), onAction: vi.fn() };

const AG_A = 'ag-tl-a';
const AG_B = 'ag-tl-b';
const ROOM = 'room-tl';

// Fixed, distinct epochs so ordering and cursor math are deterministic.
const T_PROPOSED = 4_000_000; // pending card (A)
const T_KEPT_CARD = 3_000_000; // kept card (A)
const T_DISCARDED = 2_500_000; // discarded card (B)
const T_REVISED = 1_500_000; // .history snapshot (A) — kept fallback ties here
const T_DRAFT_NOCARD = 1_000_000; // pending draft with no card (A)

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
  for (const g of [AG_A, AG_B]) {
    fs.rmSync(path.join(process.cwd(), 'data', 'v2-sessions', g), { recursive: true, force: true });
  }
  fs.rmSync(path.join(process.cwd(), 'data', 'skill-drafts'), { recursive: true, force: true });
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

const now = '2026-07-22T00:00:00.000Z';
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
  group(AG_A, 'Alpha');
  group(AG_B, 'Beta');
  role('webchat:owner', 'owner', null);
  role('webchat:admina', 'admin', AG_A); // scoped admin of A only
}

function writeScopedLearnedSkill(agentGroupId: string, name: string, revisionTs?: number): void {
  const skillsDir = path.join(process.cwd(), 'data', 'v2-sessions', agentGroupId, '.claude-shared', 'skills');
  const dir = path.join(skillsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: learned\n---\nBody.\n`);
  fs.writeFileSync(path.join(dir, '.origin.json'), JSON.stringify({ label: 'learned', official: false }));
  if (revisionTs !== undefined) {
    const snap = path.join(skillsDir, '.history', name, String(revisionTs));
    fs.mkdirSync(snap, { recursive: true });
    fs.writeFileSync(path.join(snap, 'SKILL.md'), 'previous version\n');
  }
}

interface TimelineEvent {
  id: string;
  kind: string;
  ts: number;
  agentGroupId: string;
  agentName: string;
  skillName: string;
  roomId?: string | null;
  roomName?: string | null;
  by?: string | null;
  draftId?: string;
  skillExists?: boolean;
  canRevert?: boolean;
}

describe('GET /api/learning/timeline', () => {
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
    const db = loaded.conn.getDb();
    seed(db);

    // A webchat room wired to agent A, so card events carry a room name.
    server.wireAgentToWebchatRoom('Ops room', ROOM, AG_A);

    const wdb = await import('./db.js');
    const card = (draftId: string, agentGroupId: string, agentName: string, skillName: string) =>
      wdb.storeWebchatSkillDraftCard(ROOM, agentName, {
        draftId,
        skillName,
        description: `About ${skillName}`,
        kind: 'create',
        targetSkill: null,
        agentGroupId,
        agentName,
      });
    card('d-pending', AG_A, 'Alpha', 'pending-skill');
    card('d-kept', AG_A, 'Alpha', 'kept-skill');
    card('d-disc', AG_B, 'Beta', 'discarded-skill');
    wdb.markRoomSkillDraftResolved('d-kept', 'kept', 'webchat:owner');
    wdb.markRoomSkillDraftResolved('d-disc', 'discarded', 'expired');
    // Pin card timestamps so ordering/cursor assertions are deterministic.
    const setTs = (draftId: string, ts: number) =>
      db.prepare(`UPDATE webchat_messages SET created_at = ? WHERE id = ?`).run(ts, `skill-draft-card-${draftId}`);
    setTs('d-pending', T_PROPOSED);
    setTs('d-kept', T_KEPT_CARD);
    setTs('d-disc', T_DISCARDED);

    // A pending draft that never got a card (non-webchat proposal), for A.
    const drafts = await import('../../db/skill-drafts.js');
    drafts.createSkillDraft({
      id: 'd-nocard',
      agent_group_id: AG_A,
      session_id: null,
      kind: 'create',
      skill_name: 'cardless-skill',
      target_skill: null,
      description: 'No card anywhere',
      body: '---\nname: cardless-skill\ndescription: x\n---\nBody.\n',
    });
    db.prepare(`UPDATE skill_drafts SET created_at = ? WHERE id = 'd-nocard'`).run(T_DRAFT_NOCARD);

    // On disk for A: a learned skill with one revision snapshot (→ one
    // 'revised' event at T_REVISED, and a fallback 'kept' tied to the same ts
    // since no card records its keep), plus a curator-archived skill.
    writeScopedLearnedSkill(AG_A, 'learned-a', T_REVISED);
    const archived = path.join(
      process.cwd(),
      'data',
      'v2-sessions',
      AG_A,
      '.claude-shared',
      'skills',
      '.archive',
      'old-skill',
    );
    fs.mkdirSync(archived, { recursive: true });
    fs.writeFileSync(path.join(archived, 'SKILL.md'), 'archived body\n');

    wc = await server.startWebchatServer(noopHooks);
    port = portOf(wc);
  });

  afterEach(async () => {
    if (wc) await server.stopWebchatServer(wc);
  });

  const as = (name: string) => ({ 'x-forwarded-user': name });

  async function fetchTimeline(
    userName: string,
    qs = '',
  ): Promise<{ events: TimelineEvent[]; nextBefore: number | null }> {
    const r = await httpRequest(port, 'GET', `/api/learning/timeline${qs}`, as(userName));
    expect(r.status).toBe(200);
    return JSON.parse(r.body) as { events: TimelineEvent[]; nextBefore: number | null };
  }

  it('owner sees every kind, shaped and newest-first', async () => {
    const { events, nextBefore } = await fetchTimeline('owner');
    expect(nextBefore).toBeNull();

    const byId = new Map(events.map((e) => [e.id, e]));
    expect(byId.get('card-d-pending')).toMatchObject({
      kind: 'proposed',
      ts: T_PROPOSED,
      agentGroupId: AG_A,
      agentName: 'Alpha',
      skillName: 'pending-skill',
      roomId: ROOM,
      roomName: 'Ops room',
      draftId: 'd-pending',
    });
    // Kept card: attribution survives; the skill never landed on disk here.
    expect(byId.get('card-d-kept')).toMatchObject({
      kind: 'kept',
      ts: T_KEPT_CARD,
      by: 'webchat:owner',
      skillExists: false,
    });
    expect(byId.get('card-d-disc')).toMatchObject({
      kind: 'discarded',
      agentGroupId: AG_B,
      agentName: 'Beta',
      by: 'expired',
    });
    // Card-less pending draft still shows as proposed.
    expect(byId.get('draft-d-nocard')).toMatchObject({
      kind: 'proposed',
      ts: T_DRAFT_NOCARD,
      skillName: 'cardless-skill',
    });
    // Disk: the revision snapshot, revertible (newest of a live skill)…
    expect(byId.get(`rev-${AG_A}-learned-a-${T_REVISED}`)).toMatchObject({
      kind: 'revised',
      ts: T_REVISED,
      skillName: 'learned-a',
      skillExists: true,
      canRevert: true,
    });
    // …and the card-less keep, dated by its first revision (lower bound).
    expect(byId.get(`keep-${AG_A}-learned-a`)).toMatchObject({
      kind: 'kept',
      ts: T_REVISED,
      skillExists: true,
    });
    expect(byId.get(`keep-${AG_A}-learned-a`)?.canRevert).toBeUndefined();
    // Curator archive shows as an informational event.
    expect(byId.get(`arch-${AG_A}-old-skill`)).toMatchObject({ kind: 'archived', skillName: 'old-skill' });

    // Newest-first throughout.
    const ts = events.map((e) => e.ts);
    expect([...ts].sort((a, b) => b - a)).toEqual(ts);
    // At the tied ts, the revision ranks above the kept it dates.
    expect(events.findIndex((e) => e.id.startsWith('rev-'))).toBeLessThan(
      events.findIndex((e) => e.id.startsWith('keep-')),
    );
  });

  it('a scoped admin sees only their groups (drafts-list visibility rule)', async () => {
    const { events } = await fetchTimeline('admina');
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.agentGroupId === AG_A)).toBe(true);
    expect(events.some((e) => e.id === 'card-d-disc')).toBe(false);
  });

  it('non-admins get 403', async () => {
    const r = await httpRequest(port, 'GET', '/api/learning/timeline', as('rando'));
    expect(r.status).toBe(403);
  });

  it('paginates with a before-cursor and never splits a timestamp tie', async () => {
    const all = (await fetchTimeline('owner')).events.map((e) => e.id);

    const seen: string[] = [];
    let qs = '?limit=2';
    for (let hops = 0; hops < 10; hops++) {
      const page = await fetchTimeline('owner', qs);
      seen.push(...page.events.map((e) => e.id));
      if (page.nextBefore === null) break;
      // Strictly-less cursor: nothing at or after the boundary reappears.
      expect(page.events.every((e) => e.ts >= (page.nextBefore as number))).toBe(true);
      qs = `?limit=2&before=${page.nextBefore}`;
    }
    // Every event exactly once — the tied revised+kept pair included.
    expect(seen).toEqual(all);
  });
});
