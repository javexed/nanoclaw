import { test, expect } from '@playwright/test';
import type { AddressInfo } from 'net';
import fs from 'fs';
import path from 'path';

/**
 * Skills page 'Add from link…' — learn a skill from a URL, run by an agent.
 *
 * /learn is room-mediated by design: the command must run IN a session of the
 * chosen agent. The flow is URL input (first-token validated) → agent picker
 * (only agents the caller admins; agents with no webchat room are disabled) →
 * join the resolved room and send `/learn <url>` as the user — the command is
 * visible in the room's transcript, exactly like typing it there. Same
 * in-process boot as the other e2e specs.
 */

let wc: { http: import('http').Server; host: string };
let baseURL = '';
let stop: () => Promise<void>;
let closeDb: () => void;

const ROOM_ID = 'link-room';
const AGENT_ID = 'ag-link';
const ROOMLESS_AGENT_ID = 'ag-roomless';

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
  mk(AGENT_ID, 'Link Agent', 'link-agent');
  mk(ROOMLESS_AGENT_ID, 'Roomless Agent', 'roomless-agent');

  const srv = await import('../dist/channels/webchat/server.js');
  wc = await srv.startWebchatServer({ onInbound() {}, onAction() {} });
  baseURL = `http://127.0.0.1:${(wc.http.address() as AddressInfo).port}`;
  srv.wireAgentToWebchatRoom('Link Room', ROOM_ID, AGENT_ID);

  const wdb = await import('../dist/channels/webchat/db.js');
  // The Skills menu item is gated on the marketplace toggle (off by default).
  wdb.setMarketplaceDisabled(false);

  stop = () => srv.stopWebchatServer(wc);
  closeDb = () => conn.closeDb();
});

test.afterAll(async () => {
  if (stop) await stop();
  if (closeDb) closeDb();
  for (const id of [AGENT_ID, ROOMLESS_AGENT_ID]) {
    fs.rmSync(path.join(process.cwd(), 'data', 'v2-sessions', id), { recursive: true, force: true });
  }
});

test('Add from link…: URL modal → agent picker → /learn lands in the agent’s room', async ({ page }) => {
  await page.route('**/api/webchat/onboarding', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ canEdit: false, complete: true }) }),
  );
  await page.goto(baseURL);
  await expect(page.locator('#create-room-btn')).toBeVisible();

  await page.click('#overflow-btn');
  await page.click('#overflow-skills');
  const addLink = page.locator('#skills-learn-link');
  await expect(addLink).toBeVisible();
  await addLink.click();

  // URL modal: first-token validation is URL-only here.
  const modal = page.locator('.confirm-modal');
  await expect(modal).toContainText('Learn from a link');
  await page.fill('.confirm-input', '/workspace/not-a-url');
  await modal.locator('.btn-primary', { hasText: 'Learn' }).click();
  await expect(modal.locator('.confirm-input-error')).toBeVisible();
  await page.fill('.confirm-input', 'https://example.com/howto');
  await modal.locator('.btn-primary', { hasText: 'Learn' }).click();

  // Agent picker: the roomless agent is present but disabled; the wired agent
  // is preselected. One room → no room select shown.
  const picker = page.locator('.confirm-modal', { hasText: 'Learn with which agent?' });
  await expect(picker).toBeVisible();
  const agentSel = picker.locator('.learn-target-picker select').first();
  await expect(agentSel).toHaveValue(AGENT_ID);
  expect(await agentSel.locator(`option[value="${ROOMLESS_AGENT_ID}"]`).isDisabled()).toBe(true);
  await expect(picker.locator('.learn-target-picker select').nth(1)).toBeHidden();
  await picker.locator('.btn-primary', { hasText: 'Learn' }).click();

  // Room-mediated: we land in the room and the command is in the transcript.
  await expect(page.locator('#manage')).toBeHidden();
  await expect(page.locator('#message-input')).toBeEnabled();
  await expect(page.locator('#messages .msg.mine').last()).toContainText('/learn https://example.com/howto');
});
