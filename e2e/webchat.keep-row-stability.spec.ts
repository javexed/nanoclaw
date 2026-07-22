import { test, expect, type Page } from '@playwright/test';
import type { AddressInfo } from 'net';
import fs from 'fs';
import path from 'path';

/**
 * Keep-row typography stability (learning loop).
 *
 * Regression: pressing Keep on a skill draft visibly "resized" the row's name
 * and description. The fonts never changed — armUndo swapped the compact
 * Keep/Discard buttons for the wider undo widget (label + bar + Undo), which
 * grew the actions box, squeezed the sibling .skill-info column, wrapped the
 * bold name onto two lines and re-truncated the description. After the
 * countdown the drained widget lingered forever (the 'Reviewing…' state landed
 * on a detached button).
 *
 * The fix freezes the actions container's width for the countdown and restores
 * the original buttons on commit, so 'Keeping…' → 'Reviewing…' happens on the
 * real button (which reserves its widest label via min-width). This spec
 * asserts the contract on both Keep surfaces — the Skills-panel draft row and
 * the in-room draft card: name + description computed font-size/line-height
 * AND rects are identical before, during the undo countdown, and during
 * 'Reviewing…'.
 *
 * The keep POST is intercepted with a plain 202 (no WS outcome ever arrives),
 * so the 'Reviewing…' state is held deterministically instead of racing the
 * server's overlap review. Same in-process boot as the other e2e specs.
 */

let wc: { http: import('http').Server; host: string };
let baseURL = '';
let stop: () => Promise<void>;
let closeDb: () => void;

const PANEL_DRAFT = 'draft-stability-panel';
const CARD_DRAFT = 'draft-stability-card';
const ROOM_ID = 'keep-room';
const DESCRIPTION = 'A staged draft used to verify Keep-row typography stability.';

test.beforeAll(async () => {
  process.env.WEBCHAT_HOST = '127.0.0.1';
  process.env.WEBCHAT_PORT = '0'; // ephemeral
  process.env.WEBCHAT_TOKEN = ''; // none → loopback trusted (first identity = owner)
  process.env.WEBCHAT_TAILSCALE = '';
  process.env.WEBCHAT_TRUSTED_PROXY_IPS = '';

  const conn = await import('../dist/db/connection.js');
  conn.initTestDb();
  const mig = await import('../dist/db/migrations/index.js');
  mig.runMigrations(conn.getDb());

  const ag = await import('../dist/db/agent-groups.js');
  ag.createAgentGroup({
    id: 'ag-keep',
    name: 'Keep Agent',
    folder: 'keep-agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  } as Parameters<typeof ag.createAgentGroup>[0]);

  const drafts = await import('../dist/db/skill-drafts.js');
  for (const [id, name] of [
    [PANEL_DRAFT, 'stability-panel-skill'],
    [CARD_DRAFT, 'stability-card-skill'],
  ] as const) {
    drafts.createSkillDraft({
      id,
      agent_group_id: 'ag-keep',
      session_id: 'sess-1',
      kind: 'create',
      skill_name: name,
      target_skill: null,
      description: DESCRIPTION,
      body: `---\nname: ${name}\ndescription: stability\n---\n\nBody.\n`,
    });
  }

  const srv = await import('../dist/channels/webchat/server.js');
  wc = await srv.startWebchatServer({ onInbound() {}, onAction() {} });
  baseURL = `http://127.0.0.1:${(wc.http.address() as AddressInfo).port}`;
  srv.wireAgentToWebchatRoom('Keep Room', ROOM_ID, 'ag-keep');

  const wdb = await import('../dist/channels/webchat/db.js');
  // The Skills menu item is gated on the marketplace toggle (off by default).
  wdb.setMarketplaceDisabled(false);
  wdb.storeWebchatSkillDraftCard(ROOM_ID, 'Keep Agent', {
    draftId: CARD_DRAFT,
    skillName: 'stability-card-skill',
    description: DESCRIPTION,
    kind: 'create',
    targetSkill: null,
    agentGroupId: 'ag-keep',
    agentName: 'Keep Agent',
  });

  stop = () => srv.stopWebchatServer(wc);
  closeDb = () => conn.closeDb();
});

test.afterAll(async () => {
  if (stop) await stop();
  if (closeDb) closeDb();
  fs.rmSync(path.join(process.cwd(), 'data', 'skill-drafts'), { recursive: true, force: true });
});

/** Computed typography + geometry of one element. */
type Metrics = { fontSize: string; lineHeight: string; fontWeight: string; w: number; h: number };

function measure(page: Page, sel: string): Promise<Metrics> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`not found: ${sel}`);
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { fontSize: cs.fontSize, lineHeight: cs.lineHeight, fontWeight: cs.fontWeight, w: r.width, h: r.height };
  }, sel);
}

/** name+desc must not change typography OR footprint across a Keep state change. */
function expectStable(before: Metrics, later: Metrics, what: string) {
  expect(later.fontSize, `${what} font-size`).toBe(before.fontSize);
  expect(later.lineHeight, `${what} line-height`).toBe(before.lineHeight);
  expect(later.fontWeight, `${what} font-weight`).toBe(before.fontWeight);
  // Rect equality is the reflow guard: a wrapped name doubles its height, a
  // squeezed description shrinks its width — with identical fonts.
  expect(Math.abs(later.w - before.w), `${what} width`).toBeLessThanOrEqual(1);
  expect(Math.abs(later.h - before.h), `${what} height`).toBeLessThanOrEqual(1);
}

/** Hold 'Reviewing…' deterministically: 202 accepted, outcome never pushed. */
async function interceptKeep(page: Page) {
  await page.route('**/api/skill-drafts/*/keep*', (r) =>
    r.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ queued: true }) }),
  );
}

async function openApp(page: Page) {
  await page.route('**/api/webchat/onboarding', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ canEdit: false, complete: true }) }),
  );
  await interceptKeep(page);
  await page.goto(baseURL);
  await expect(page.locator('#create-room-btn')).toBeVisible();
}

/** Drive one Keep surface through undo-countdown and Reviewing, asserting stability. */
async function driveKeep(page: Page, draftId: string, nameSel: string, descSel: string, keepSel: string) {
  const name0 = await measure(page, nameSel);
  const desc0 = await measure(page, descSel);
  const keep0 = await measure(page, keepSel);

  await page.click(keepSel);
  // Undo countdown: the widget must live inside the frozen footprint.
  await expect(page.locator('.undo-timer')).toBeVisible();
  expectStable(name0, await measure(page, nameSel), 'name (during undo)');
  expectStable(desc0, await measure(page, descSel), 'desc (during undo)');

  // Countdown commits at 10s → buttons restored → POST → 202 → 'Reviewing…'.
  const keepBtn = page.locator(`button[data-draft-id="${draftId}"]`);
  await expect(keepBtn).toHaveText('Reviewing…', { timeout: 15_000 });
  await expect(keepBtn).toBeDisabled();
  expectStable(name0, await measure(page, nameSel), 'name (reviewing)');
  expectStable(desc0, await measure(page, descSel), 'desc (reviewing)');
  // The control itself must not resize either — its min-width reserves the
  // widest label, so Keep → Reviewing… is a text change, not a layout change.
  expectStable(keep0, await measure(page, keepSel), 'keep button');
  // And the drained undo widget must be gone, not lingering next to it.
  await expect(page.locator('.undo-timer')).toHaveCount(0);
}

test('Skills panel: Keep never reflows the draft row (name/desc stable through undo + Reviewing…)', async ({
  page,
}) => {
  test.setTimeout(45_000);
  await openApp(page);
  await page.click('#overflow-btn');
  await page.click('#overflow-skills');
  const row = page.locator('#skill-drafts-list .skill-row', { hasText: 'stability-panel-skill' });
  await expect(row).toBeVisible();

  const rowSel = `#skill-drafts-list .skill-row[data-draft-id="${PANEL_DRAFT}"]`;
  await driveKeep(
    page,
    PANEL_DRAFT,
    `${rowSel} .skill-name`,
    `${rowSel} .skill-desc`,
    `button[data-draft-id="${PANEL_DRAFT}"]`,
  );
});

test('in-room draft card: Keep never reflows the card (name/desc stable through undo + Reviewing…)', async ({
  page,
}) => {
  test.setTimeout(45_000);
  await openApp(page);
  await page.click(`#room-list li[data-room-id="${ROOM_ID}"]`);
  const card = page.locator('.skill-draft-msg .skill-draft-card');
  await expect(card).toBeVisible();

  const cardSel = '.skill-draft-msg .skill-draft-card';
  await driveKeep(
    page,
    CARD_DRAFT,
    `${cardSel} .skill-name`,
    `${cardSel} .skill-desc`,
    `button[data-draft-id="${CARD_DRAFT}"]`,
  );
});
