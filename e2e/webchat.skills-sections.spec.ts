import { test, expect, type Page } from '@playwright/test';
import type { AddressInfo } from 'net';
import fs from 'fs';
import path from 'path';

/**
 * Skills page sections + filter.
 *
 * The registry grew to ~60 flat rows once agent-scoped skills joined the
 * list. The page now renders collapsible owner sections — 'Workspace' (the
 * shared pool, expanded by default) first, then one section per agent that
 * carries scoped skills (collapsed by default), each header showing the
 * agent's name, its room pill when it serves exactly one room, and a count.
 * Collapse state persists per section in localStorage
 * (skillsSectionOpen:<pool|agentGroupId>). A filter box above the sections
 * matches name+description; matching sections auto-expand showing only
 * matching rows, empty sections hide, and clearing restores the persisted
 * collapse states.
 *
 * This spec seeds one scoped skill on disk (a real dir under the agent's
 * .claude-shared/skills — same fixture shape as skills-list-scoped.test.ts)
 * and asserts: section rendering + defaults, toggle persistence across a
 * reload, and filter auto-expand/restore. Same in-process boot as the other
 * e2e specs.
 */

let wc: { http: import('http').Server; host: string };
let baseURL = '';
let stop: () => Promise<void>;
let closeDb: () => void;

const AGENT_ID = 'ag-sections';
const AGENT_NAME = 'Sections Agent';
const ROOM_ID = 'sections-room';
const ROOM_NAME = 'Sections Room';
const SCOPED_SKILL = 'zz-sectioned-skill';
const SCOPED_DESC = 'A scoped fixture skill used to verify Skills-page sections.';

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
    id: AGENT_ID,
    name: AGENT_NAME,
    folder: 'sections-agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  } as Parameters<typeof ag.createAgentGroup>[0]);

  // Scoped skill = a real dir in the agent's own .claude-shared/skills.
  const dir = path.join(process.cwd(), 'data', 'v2-sessions', AGENT_ID, '.claude-shared', 'skills', SCOPED_SKILL);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${SCOPED_SKILL}\ndescription: ${SCOPED_DESC}\n---\nBody.\n`,
  );

  const srv = await import('../dist/channels/webchat/server.js');
  wc = await srv.startWebchatServer({ onInbound() {}, onAction() {} });
  baseURL = `http://127.0.0.1:${(wc.http.address() as AddressInfo).port}`;
  // One room → the agent's section header carries the room pill.
  srv.wireAgentToWebchatRoom(ROOM_NAME, ROOM_ID, AGENT_ID);

  const wdb = await import('../dist/channels/webchat/db.js');
  // The Skills menu item is gated on the marketplace toggle (off by default).
  wdb.setMarketplaceDisabled(false);

  stop = () => srv.stopWebchatServer(wc);
  closeDb = () => conn.closeDb();
});

test.afterAll(async () => {
  if (stop) await stop();
  if (closeDb) closeDb();
  fs.rmSync(path.join(process.cwd(), 'data', 'v2-sessions', AGENT_ID), { recursive: true, force: true });
});

async function openSkills(page: Page) {
  await page.route('**/api/webchat/onboarding', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ canEdit: false, complete: true }) }),
  );
  await page.goto(baseURL);
  await expect(page.locator('#create-room-btn')).toBeVisible();
  await page.click('#overflow-btn');
  await page.click('#overflow-skills');
  await expect(page.locator('#skills-list .skills-section-head').first()).toBeVisible();
}

const workspaceHead = (page: Page) => page.locator('#skills-list li[data-section-head="pool"]');
const agentHead = (page: Page) => page.locator(`#skills-list li[data-section-head="${AGENT_ID}"]`);
const scopedRow = (page: Page) => page.locator(`#skills-list li.skill-row[data-section="${AGENT_ID}"]`);

test('sections render: Workspace expanded with pool rows, agent section collapsed with pill + count', async ({
  page,
}) => {
  await openSkills(page);

  // Workspace first, expanded by default, with visible pool rows and a count.
  const ws = workspaceHead(page);
  await expect(ws).toBeVisible();
  await expect(ws).toHaveClass(/\bopen\b/);
  await expect(ws).toHaveAttribute('aria-expanded', 'true');
  await expect(ws.locator('.skills-section-label')).toHaveText('Workspace');
  const poolRows = page.locator('#skills-list li.skill-row[data-section="pool"]');
  expect(await poolRows.count()).toBeGreaterThan(0);
  await expect(poolRows.first()).toBeVisible();

  // Agent section: header shows the agent name + its (single) room pill +
  // count, collapsed by default — the scoped row exists but is hidden.
  const ah = agentHead(page);
  await expect(ah).toBeVisible();
  await expect(ah).not.toHaveClass(/\bopen\b/);
  await expect(ah).toHaveAttribute('aria-expanded', 'false');
  await expect(ah.locator('.skills-section-label')).toHaveText(AGENT_NAME);
  await expect(ah.locator('.skill-badge-scope')).toHaveText(ROOM_NAME);
  await expect(ah.locator('.skills-section-count')).toHaveText('1');
  await expect(scopedRow(page)).toBeHidden();

  // Workspace precedes the agent section in the DOM.
  const order = await page.$$eval('#skills-list li[data-section-head]', (els) =>
    els.map((el) => (el as HTMLElement).dataset.sectionHead),
  );
  expect(order[0]).toBe('pool');
  expect(order).toContain(AGENT_ID);
});

test('toggling a section persists across reload (localStorage)', async ({ page }) => {
  await openSkills(page);

  await expect(scopedRow(page)).toBeHidden();
  await agentHead(page).click();
  await expect(agentHead(page)).toHaveClass(/\bopen\b/);
  await expect(scopedRow(page)).toBeVisible();

  // Reload: same context → same localStorage → the agent section stays open.
  await page.reload();
  await expect(page.locator('#create-room-btn')).toBeVisible();
  await page.click('#overflow-btn');
  await page.click('#overflow-skills');
  await expect(agentHead(page)).toHaveClass(/\bopen\b/);
  await expect(scopedRow(page)).toBeVisible();

  // Collapse Workspace too, and verify that side persists as well.
  await workspaceHead(page).click();
  await expect(workspaceHead(page)).not.toHaveClass(/\bopen\b/);
  await page.reload();
  await expect(page.locator('#create-room-btn')).toBeVisible();
  await page.click('#overflow-btn');
  await page.click('#overflow-skills');
  await expect(workspaceHead(page)).not.toHaveClass(/\bopen\b/);
  await expect(page.locator('#skills-list li.skill-row[data-section="pool"]').first()).toBeHidden();
});

test('filter auto-expands matching sections, hides empty ones, and restores state on clear', async ({ page }) => {
  await openSkills(page);
  await expect(scopedRow(page)).toBeHidden(); // collapsed default

  // A query matching only the scoped skill: its section force-opens showing
  // the row; Workspace has no match and hides entirely.
  await page.fill('#skills-filter', 'zz-sectioned');
  await expect(scopedRow(page)).toBeVisible();
  await expect(agentHead(page)).toHaveClass(/\bopen\b/);
  await expect(workspaceHead(page)).toBeHidden();

  // Description text matches too (case-insensitive).
  await page.fill('#skills-filter', 'SCOPED FIXTURE');
  await expect(scopedRow(page)).toBeVisible();
  await expect(workspaceHead(page)).toBeHidden();

  // No match anywhere → every section hides, the empty state shows.
  await page.fill('#skills-filter', 'no-skill-matches-this');
  await expect(workspaceHead(page)).toBeHidden();
  await expect(agentHead(page)).toBeHidden();
  await expect(page.locator('#skills-no-match')).toBeVisible();

  // Clearing restores the persisted collapse states: Workspace open again,
  // agent section back to collapsed, empty state gone.
  await page.fill('#skills-filter', '');
  await expect(workspaceHead(page)).toBeVisible();
  await expect(workspaceHead(page)).toHaveClass(/\bopen\b/);
  await expect(agentHead(page)).toBeVisible();
  await expect(agentHead(page)).not.toHaveClass(/\bopen\b/);
  await expect(scopedRow(page)).toBeHidden();
  await expect(page.locator('#skills-no-match')).toBeHidden();
});
