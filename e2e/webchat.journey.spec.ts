import { test, expect } from '@playwright/test';
import type { AddressInfo } from 'net';
import fs from 'fs';
import path from 'path';

/**
 * Journey view (learning timeline) — opens from the overflow menu, renders a
 * seeded kept-event as a compact row (verb + skill name + agent pill), and
 * dismisses per the contract (Escape pops the top view, back to chat).
 *
 * The kept event comes from a persisted in-room skill-draft card flipped to
 * 'kept' — the same durable record the live keep flow leaves behind (the
 * skill_drafts row itself is deleted on resolution). Same in-process boot as
 * the other e2e specs.
 */

let wc: { http: import('http').Server; host: string };
let baseURL = '';
let stop: () => Promise<void>;
let closeDb: () => void;

const ROOM_ID = 'journey-room';
const SKILL = 'journey-kept-skill';

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
    id: 'ag-journey',
    name: 'Journey Agent',
    folder: 'journey-agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  } as Parameters<typeof ag.createAgentGroup>[0]);

  const srv = await import('../dist/channels/webchat/server.js');
  wc = await srv.startWebchatServer({ onInbound() {}, onAction() {} });
  baseURL = `http://127.0.0.1:${(wc.http.address() as AddressInfo).port}`;
  srv.wireAgentToWebchatRoom('Journey Room', ROOM_ID, 'ag-journey');

  // The kept event: a draft card proposed in-room, resolved 'kept'.
  const wdb = await import('../dist/channels/webchat/db.js');
  wdb.storeWebchatSkillDraftCard(ROOM_ID, 'Journey Agent', {
    draftId: 'journey-draft',
    skillName: SKILL,
    description: 'A kept skill seeded for the Journey e2e.',
    kind: 'create',
    targetSkill: null,
    agentGroupId: 'ag-journey',
    agentName: 'Journey Agent',
  });
  wdb.markRoomSkillDraftResolved('journey-draft', 'kept', 'webchat:e2e-owner');

  stop = () => srv.stopWebchatServer(wc);
  closeDb = () => conn.closeDb();
});

test.afterAll(async () => {
  if (stop) await stop();
  if (closeDb) closeDb();
  fs.rmSync(path.join(process.cwd(), 'data', 'v2-sessions', 'ag-journey'), { recursive: true, force: true });
});

test('Journey opens from the menu, shows the kept event, Escape dismisses', async ({ page }) => {
  // Keep the first-run wizard out of the way (same as the other specs).
  await page.route('**/api/webchat/onboarding', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ canEdit: false, complete: true }) }),
  );
  await page.goto(baseURL);

  // Open the overflow menu; the Journey item unhides once the admin probe
  // resolves, so wait for visibility rather than existence.
  await page.click('#overflow-btn');
  const item = page.locator('#overflow-journey');
  await expect(item).toBeVisible();
  await item.click();

  // The full-view opens (desktop keeps #chat display:flex, so assert the view
  // itself + the full-view body class, not #chat visibility).
  await expect(page.locator('#journey')).toBeVisible();
  await expect(page.locator('#app')).toHaveClass(/in-dashboard/);

  // The seeded kept event renders as one compact row: verb + name + agent pill.
  const row = page.locator('.journey-row', { hasText: SKILL });
  await expect(row).toBeVisible();
  await expect(row.locator('.journey-verb')).toHaveText('Kept');
  await expect(row.locator('.skill-badge-scope')).toHaveText('Journey Agent');
  // Day grouping header is present (seeded now → "Today").
  await expect(page.locator('.journey-day').first()).toHaveText('Today');

  // Dismissal contract: Escape closes the top view and returns to chat.
  await page.keyboard.press('Escape');
  await expect(page.locator('#journey')).toBeHidden();
  await expect(page.locator('#app')).not.toHaveClass(/in-dashboard/);
});
