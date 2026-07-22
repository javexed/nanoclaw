import { test, expect } from '@playwright/test';
import type { AddressInfo } from 'net';
import fs from 'fs';
import path from 'path';

/**
 * Composer 🎓 popover — source-directed learning.
 *
 * The 🎓 button opens a small anchored popover with three label-only entries:
 * 'This session' (the old bare /learn), 'From a link…' and 'From a folder…'
 * (each an input modal that composes `/learn <source>` through the normal send
 * path — the /learn interception is container-side, so the transcript is the
 * observable seam). The link/folder modals pre-validate the FIRST token
 * (mirroring classifyLearnHint) so a typo can't silently degrade into a
 * free-text steering hint. Same in-process boot as the other e2e specs.
 */

let wc: { http: import('http').Server; host: string };
let baseURL = '';
let stop: () => Promise<void>;
let closeDb: () => void;

const ROOM_ID = 'learn-room';
const AGENT_ID = 'ag-learn';

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
    name: 'Learn Agent',
    folder: 'learn-agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  } as Parameters<typeof ag.createAgentGroup>[0]);

  const srv = await import('../dist/channels/webchat/server.js');
  wc = await srv.startWebchatServer({ onInbound() {}, onAction() {} });
  baseURL = `http://127.0.0.1:${(wc.http.address() as AddressInfo).port}`;
  srv.wireAgentToWebchatRoom('Learn Room', ROOM_ID, AGENT_ID);

  stop = () => srv.stopWebchatServer(wc);
  closeDb = () => conn.closeDb();
});

test.afterAll(async () => {
  if (stop) await stop();
  if (closeDb) closeDb();
  fs.rmSync(path.join(process.cwd(), 'data', 'v2-sessions', AGENT_ID), { recursive: true, force: true });
});

async function openRoom(page: import('@playwright/test').Page) {
  await page.route('**/api/webchat/onboarding', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ canEdit: false, complete: true }) }),
  );
  await page.goto(baseURL);
  await page.click(`#room-list li[data-room-id="${ROOM_ID}"]`);
  await expect(page.locator('#message-input')).toBeEnabled();
}

test('popover opens with the three entries, Escape dismisses', async ({ page }) => {
  await openRoom(page);

  await page.click('#learn-btn');
  const menu = page.locator('#learn-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.learn-menu-item').nth(0)).toContainText('This session');
  await expect(menu.locator('.learn-menu-item').nth(1)).toContainText('From a link…');
  await expect(menu.locator('.learn-menu-item').nth(2)).toContainText('From a folder…');
  await expect(page.locator('#learn-btn')).toHaveAttribute('aria-expanded', 'true');

  // Dismissal contract: one Escape closes the popover (and only the popover —
  // the room stays open behind it).
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(page.locator('#learn-btn')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#message-input')).toBeEnabled();
});

test("'This session' sends the bare /learn through the normal send path", async ({ page }) => {
  await openRoom(page);

  await page.click('#learn-btn');
  await page.locator('.learn-menu-item', { hasText: 'This session' }).click();
  await expect(page.locator('#learn-menu')).toBeHidden();
  // The command travels as a normal user message — visible in the transcript.
  await expect(page.locator('#messages .msg.mine').last()).toContainText('/learn');
});

test('link modal validates the first token inline, then composes /learn <url>', async ({ page }) => {
  await openRoom(page);

  await page.click('#learn-btn');
  await page.locator('.learn-menu-item', { hasText: 'From a link…' }).click();
  const modal = page.locator('.confirm-modal');
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('Learn from a link');

  // A non-source value must NOT send — inline invalid state, modal stays open.
  await page.fill('.confirm-input', 'just some notes about redis');
  await modal.locator('.btn-primary', { hasText: 'Learn' }).click();
  await expect(modal.locator('.confirm-input-error')).toBeVisible();
  await expect(modal).toBeVisible();

  // A real URL (with trailing focus text) passes the first-token rule.
  await page.fill('.confirm-input', 'https://example.com/guide focus on retries');
  await modal.locator('.btn-primary', { hasText: 'Learn' }).click();
  await expect(modal).toBeHidden();
  await expect(page.locator('#messages .msg.mine').last()).toContainText(
    '/learn https://example.com/guide focus on retries',
  );
});

test('folder modal rejects a bare word, accepts a path shape', async ({ page }) => {
  await openRoom(page);

  await page.click('#learn-btn');
  await page.locator('.learn-menu-item', { hasText: 'From a folder…' }).click();
  const modal = page.locator('.confirm-modal');
  await expect(modal).toContainText('Learn from a folder');

  await page.fill('.confirm-input', 'retry.md'); // bare word = free text, not a path
  await modal.locator('.btn-primary', { hasText: 'Learn' }).click();
  await expect(modal.locator('.confirm-input-error')).toBeVisible();

  await page.fill('.confirm-input', '/workspace/notes');
  await modal.locator('.btn-primary', { hasText: 'Learn' }).click();
  await expect(modal).toBeHidden();
  await expect(page.locator('#messages .msg.mine').last()).toContainText('/learn /workspace/notes');
});
