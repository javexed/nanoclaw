import { test, expect, type Page } from '@playwright/test';
import type { AddressInfo } from 'net';
import fs from 'fs';
import path from 'path';

/**
 * Journey filters + 'History' deep-links.
 *
 * Filters are CLIENT-side visibility over the loaded events (same posture as
 * the Skills search): an agent select (options derived from the feed), a kind
 * segmented control (All | Kept | Revised | Proposed), and a skill chip that
 * only appears via the 'History' deep-links (scoped skill rows + the scoped
 * SKILL.md editor modal) and clears on tap. Filter state is transient — it
 * resets every time the view opens. Day headers with no visible rows hide.
 *
 * Seeds: agent A with a KEPT draft card (+ the scoped skill on disk so the
 * Skills row / editor exist), agent B with a PENDING card (renders as
 * 'Proposed'). Same in-process boot as the other e2e specs.
 */

let wc: { http: import('http').Server; host: string };
let baseURL = '';
let stop: () => Promise<void>;
let closeDb: () => void;

const AG_A = 'ag-alpha';
const AG_B = 'ag-beta';
const SKILL_A = 'alpha-kept-skill';
const SKILL_B = 'beta-proposed-skill';
const ROOM_A = 'alpha-room';
const ROOM_B = 'beta-room';

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
  const mk = (id: string, name: string, folder: string) =>
    ag.createAgentGroup({
      id,
      name,
      folder,
      agent_provider: null,
      created_at: new Date().toISOString(),
    } as Parameters<typeof ag.createAgentGroup>[0]);
  mk(AG_A, 'Alpha Agent', 'alpha-agent');
  mk(AG_B, 'Beta Agent', 'beta-agent');

  // The kept skill lives on disk so the Skills page shows its scoped row and
  // the editor modal can open it (the kept CARD below dedupes the disk
  // fallback, so the timeline shows exactly one kept event for it).
  const dir = path.join(process.cwd(), 'data', 'v2-sessions', AG_A, '.claude-shared', 'skills', SKILL_A);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${SKILL_A}\ndescription: Kept fixture.\n---\nBody.\n`);

  const srv = await import('../dist/channels/webchat/server.js');
  wc = await srv.startWebchatServer({ onInbound() {}, onAction() {} });
  baseURL = `http://127.0.0.1:${(wc.http.address() as AddressInfo).port}`;
  srv.wireAgentToWebchatRoom('Alpha Room', ROOM_A, AG_A);
  srv.wireAgentToWebchatRoom('Beta Room', ROOM_B, AG_B);

  const wdb = await import('../dist/channels/webchat/db.js');
  wdb.setMarketplaceDisabled(false); // Skills page (deep-link entry) is marketplace-gated
  const card = (draftId: string, roomId: string, agentGroupId: string, agentName: string, skillName: string) =>
    wdb.storeWebchatSkillDraftCard(roomId, agentName, {
      draftId,
      skillName,
      description: `${skillName} fixture`,
      kind: 'create',
      targetSkill: null,
      agentGroupId,
      agentName,
    });
  card('draft-alpha', ROOM_A, AG_A, 'Alpha Agent', SKILL_A);
  wdb.markRoomSkillDraftResolved('draft-alpha', 'kept', 'webchat:e2e-owner');
  card('draft-beta', ROOM_B, AG_B, 'Beta Agent', SKILL_B); // stays pending → 'Proposed'

  stop = () => srv.stopWebchatServer(wc);
  closeDb = () => conn.closeDb();
});

test.afterAll(async () => {
  if (stop) await stop();
  if (closeDb) closeDb();
  for (const id of [AG_A, AG_B]) {
    fs.rmSync(path.join(process.cwd(), 'data', 'v2-sessions', id), { recursive: true, force: true });
  }
});

async function enter(page: Page) {
  await page.route('**/api/webchat/onboarding', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ canEdit: false, complete: true }) }),
  );
  await page.goto(baseURL);
  await expect(page.locator('#create-room-btn')).toBeVisible();
}

const rowA = (page: Page) => page.locator(`.journey-row[data-skill="${SKILL_A}"]`);
const rowB = (page: Page) => page.locator(`.journey-row[data-skill="${SKILL_B}"]`);

test('agent select and kind segmented narrow the loaded rows', async ({ page }) => {
  await enter(page);
  await page.click('#overflow-btn');
  const item = page.locator('#overflow-journey');
  await expect(item).toBeVisible();
  await item.click();
  await expect(rowA(page)).toBeVisible();
  await expect(rowB(page)).toBeVisible();

  // Agent filter (options derived from the loaded feed).
  await page.selectOption('#journey-agent-filter', AG_A);
  await expect(rowA(page)).toBeVisible();
  await expect(rowB(page)).toBeHidden();
  await page.selectOption('#journey-agent-filter', '');
  await expect(rowB(page)).toBeVisible();

  // Kind segmented control.
  await page.locator('#journey-kind-filter .setting-option', { hasText: 'Kept' }).click();
  await expect(rowA(page)).toBeVisible();
  await expect(rowB(page)).toBeHidden();
  await page.locator('#journey-kind-filter .setting-option', { hasText: 'Proposed' }).click();
  await expect(rowA(page)).toBeHidden();
  await expect(rowB(page)).toBeVisible();
  await page.locator('#journey-kind-filter .setting-option', { hasText: 'All' }).click();
  await expect(rowA(page)).toBeVisible();
  await expect(rowB(page)).toBeVisible();

  // No-match: an agent+kind combination with nothing loaded shows the note.
  await page.selectOption('#journey-agent-filter', AG_B);
  await page.locator('#journey-kind-filter .setting-option', { hasText: 'Kept' }).click();
  await expect(page.locator('#journey-no-match')).toBeVisible();
  await expect(page.locator('.journey-day')).toBeHidden(); // day header hides with its rows
});

test('History deep-links open Journey pre-filtered; the chip clears; state resets on reopen', async ({ page }) => {
  await enter(page);

  // (b) Skills-page scoped row → History.
  await page.click('#overflow-btn');
  await page.click('#overflow-skills');
  await page.click(`#skills-list li[data-section-head="${AG_A}"]`); // expand the agent section
  const scopedRow = page.locator(`#skills-list li.skill-row[data-section="${AG_A}"]`, { hasText: SKILL_A });
  await expect(scopedRow).toBeVisible();
  await scopedRow.locator('.skill-history-btn').click();

  await expect(page.locator('#journey')).toBeVisible();
  const chip = page.locator('#journey-skill-chip');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText(`skill: ${SKILL_A}`);
  await expect(page.locator('#journey-agent-filter')).toHaveValue(AG_A);
  await expect(rowA(page)).toBeVisible();
  await expect(rowB(page)).toBeHidden();

  // (a) Scoped editor modal → History (Journey already open: filters retarget,
  // no stacked second view). The kept row opens the editor.
  await rowA(page).click();
  const modal = page.locator('.skill-edit-modal');
  await expect(modal).toBeVisible();
  await modal.locator('.btn-ghost', { hasText: 'History' }).click();
  await expect(modal).toBeHidden();
  await expect(page.locator('#journey')).toBeVisible();
  await expect(chip).toContainText(`skill: ${SKILL_A}`);

  // Chip is dismissible: clearing it keeps the agent filter only.
  await chip.click();
  await expect(chip).toBeHidden();
  await expect(rowB(page)).toBeHidden(); // agent filter still Alpha
  await page.selectOption('#journey-agent-filter', '');
  await expect(rowB(page)).toBeVisible();

  // Transient state: closing and reopening Journey resets every filter.
  await page.keyboard.press('Escape');
  await expect(page.locator('#journey')).toBeHidden();
  await page.click('#overflow-btn');
  await page.click('#overflow-journey');
  await expect(rowA(page)).toBeVisible();
  await expect(rowB(page)).toBeVisible();
  await expect(chip).toBeHidden();
});
