import { test, expect, type Page } from '@playwright/test';
import type { AddressInfo } from 'net';

/**
 * Webchat smoke suite — six independent flows over the REAL server, run as the
 * pre-publish gate's browser tier (see verify-webchat-publish.sh §4b and
 * docs/webchat/e2e.md). Same in-process boot as the other e2e specs (dist/ +
 * in-memory DB + no-op hooks — no router/Docker/LLM), but with BEARER auth
 * configured, so flow (a) exercises the real login form instead of the
 * loopback auto-pass.
 *
 * auth.ts reads WEBCHAT_TOKEN at module load, so this file MUST run in a
 * worker process where dist/ hasn't been imported yet — the 'smoke' project in
 * playwright.config.ts guarantees that (workers never span projects).
 *
 * Flows (each test is independent; shared state is only the seeded rooms):
 *   a. bearer login → lobby renders the room list
 *   b. create a thread through the UI, land in it, badge/state updates
 *   c. send a message inside a topic thread → renders + stored with that thread_id
 *   d. upload in a NON-main thread → the POST carries ?thread_id=<that thread>
 *      (regression: uploads used to always land in main)
 *   e. failing API call → error toast with role="alert"
 *      (regression: error toasts once rendered as polite status, invisible to SRs)
 *   f. Escape closes the top layer (settings overlay)
 */

// Block the service worker: on its FIRST activation the app's update handler
// reloads the page when the login screen shows an empty token field (app.js
// tryReload/safeToReload) — a reload racing the form fill made login flaky.
// The SW is not what these flows cover; sw-cache.test.ts owns that surface.
test.use({ serviceWorkers: 'block' });

const TOKEN = 'e2e-smoke-bearer-token-0123456789abcdef'; // ≥ MIN_BEARER_TOKEN_LENGTH (24)
const ROOM_ID = 'smoke-room'; // rooms show as "#<id>" in the sidebar
const THREAD_ROOM_ID = 'thread-room'; // starts with zero threads — flow (b) creates the first

let wc: { http: import('http').Server; host: string };
// The page is loaded via smoke.localhost (Chromium resolves *.localhost to
// 127.0.0.1 per RFC 6761): the client's checkAuth() short-circuits "no auth
// needed" for the literal hostnames localhost/127.0.0.1, so the real bearer
// login form only renders under a non-literal loopback name.
let baseURL = '';
let stop: () => Promise<void>;
let closeDb: () => void;
let db: typeof import('../dist/channels/webchat/db.js');

test.beforeAll(async () => {
  process.env.WEBCHAT_HOST = '127.0.0.1';
  process.env.WEBCHAT_PORT = '0'; // ephemeral
  process.env.WEBCHAT_TOKEN = TOKEN; // bearer configured → loopback NOT auto-trusted
  process.env.WEBCHAT_TAILSCALE = '';
  process.env.WEBCHAT_TRUSTED_PROXY_IPS = '';

  const conn = await import('../dist/db/connection.js');
  conn.initTestDb();
  const mig = await import('../dist/db/migrations/index.js');
  mig.runMigrations(conn.getDb());

  const ag = await import('../dist/db/agent-groups.js');
  ag.createAgentGroup({
    id: 'ag-smoke',
    name: 'Smoke Agent',
    folder: 'smoke-agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  } as Parameters<typeof ag.createAgentGroup>[0]);

  const srv = await import('../dist/channels/webchat/server.js');
  wc = await srv.startWebchatServer({ onInbound() {}, onAction() {} });
  baseURL = `http://smoke.localhost:${(wc.http.address() as AddressInfo).port}`;

  // Seed two rooms wired to the agent — server-side, so no flow depends on
  // another flow having created its room.
  srv.wireAgentToWebchatRoom('Smoke Room', ROOM_ID, 'ag-smoke');
  srv.wireAgentToWebchatRoom('Thread Room', THREAD_ROOM_ID, 'ag-smoke');

  db = await import('../dist/channels/webchat/db.js');
  stop = () => srv.stopWebchatServer(wc);
  closeDb = () => conn.closeDb();
});

test.afterAll(async () => {
  if (stop) await stop();
  if (closeDb) closeDb();
});

/** Log in through the real bearer form and wait for the lobby. */
async function enter(page: Page): Promise<void> {
  // The first-run setup wizard auto-opens for a fresh owner and its overlay
  // intercepts every click — report onboarding as complete so specs drive the
  // app, not the wizard. (Same suppression as the other e2e specs.)
  await page.route('**/api/webchat/onboarding', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ canEdit: false, complete: true }) }),
  );
  await page.goto(baseURL);
  // Bearer is configured, so loopback is NOT auto-trusted: the login form must
  // actually appear (this is flow (a)'s load-bearing assertion, and every other
  // flow re-proves it since sessionStorage starts empty per test).
  await expect(page.locator('#login-screen')).toBeVisible();
  await page.fill('#login-token', TOKEN);
  await page.click('#login-form button[type="submit"]');
  await expect(page.locator('#login-screen')).toBeHidden();
}

function roomRow(page: Page, roomId: string) {
  return page.locator(`#room-list li[data-room-id="${roomId}"]`);
}

/** Join a room from the lobby and wait for the composer to unlock. */
async function openRoom(page: Page, roomId: string): Promise<void> {
  await roomRow(page, roomId).locator('.room-row-name').click();
  await expect(page.locator('#message-input')).toBeEnabled();
}

/** Open a (server-seeded) topic thread from the sidebar thread tree. */
async function openThreadRow(page: Page, title: string): Promise<void> {
  await page.locator('.thread-row', { hasText: title }).click();
  await expect(page.locator('#thread-crumb')).toBeVisible();
  await expect(page.locator('#thread-crumb-name')).toHaveText(title);
}

test('a. bearer login renders the lobby room list', async ({ page }) => {
  await enter(page);
  await expect(roomRow(page, ROOM_ID)).toBeVisible();
  await expect(roomRow(page, ROOM_ID).locator('.room-row-name')).toHaveText(`#${ROOM_ID}`);
  await expect(roomRow(page, THREAD_ROOM_ID)).toBeVisible();
});

test('b. create a thread, land in it, thread state updates', async ({ page }) => {
  await enter(page);
  await openRoom(page, THREAD_ROOM_ID);

  // First thread in this room → the "+" affordance sits inline on the active
  // room row; it opens an inline name input, Enter creates AND enters the thread.
  await roomRow(page, THREAD_ROOM_ID).locator('.thread-add-inline').click();
  const nameInput = page.locator('.thread-add-input');
  await nameInput.fill('Planning');
  await nameInput.press('Enter');

  // Landed in the new thread: breadcrumb names it…
  await expect(page.locator('#thread-crumb')).toBeVisible();
  await expect(page.locator('#thread-crumb-name')).toHaveText('Planning');
  // …the sidebar row is the active one…
  const active = page.locator('.thread-row[aria-current="true"]');
  await expect(active.locator('.thread-label')).toHaveText('Planning');
  // …and the header switcher badges the topic-thread count. (CSS shows the
  // switcher on mobile only, so assert content/state, not visibility.)
  await expect(page.locator('#thread-switch')).toHaveClass(/has-threads/);
  await expect(page.locator('#thread-switch')).toHaveText(/^#\d+$/);
});

test('c. a message sent in a thread renders there and stores with that thread_id', async ({ page }) => {
  const thread = db.createWebchatThread(ROOM_ID, 'Notes C');
  await enter(page);
  await openRoom(page, ROOM_ID);
  await openThreadRow(page, 'Notes C');

  const text = 'hello inside thread c';
  await page.fill('#message-input', text);
  await page.click('#send-btn');
  await expect(page.locator('#messages')).toContainText(text);

  // Server truth: stored under the topic thread, not main.
  await expect
    .poll(() => db.getWebchatMessages(ROOM_ID, 200, thread.thread_id).some((m) => m.content === text))
    .toBe(true);
  expect(db.getWebchatMessages(ROOM_ID, 200, 'main').some((m) => m.content === text)).toBe(false);
});

test('d. upload in a non-main thread carries that thread_id on the POST', async ({ page }) => {
  const thread = db.createWebchatThread(ROOM_ID, 'Uploads D');
  await enter(page);
  await openRoom(page, ROOM_ID);
  await openThreadRow(page, 'Uploads D');

  // Stage a small file via the real picker (the input is created on click, so
  // go through the filechooser event, not a selector).
  const chooser = page.waitForEvent('filechooser');
  await page.click('#file-picker');
  await (await chooser).setFiles({
    name: 'smoke.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('e2e upload smoke payload'),
  });

  // Send → the upload POST must target THIS thread (regression: uploads used
  // to omit thread_id and land in main).
  const uploadReq = page.waitForRequest((r) => r.method() === 'POST' && r.url().includes('/upload'));
  await page.click('#send-btn');
  const req = await uploadReq;
  expect(new URL(req.url()).searchParams.get('thread_id')).toBe(thread.thread_id);
  const res = await req.response();
  expect(res?.ok()).toBe(true);

  // And the file message lands in the thread, client + server side.
  await expect(page.locator('#messages')).toContainText('smoke.txt');
  await expect
    .poll(() =>
      db.getWebchatMessages(ROOM_ID, 200, thread.thread_id).some((m) => m.message_type === 'file'),
    )
    .toBe(true);
});

test('e. a failing API call surfaces an error toast with role="alert"', async ({ page }) => {
  await enter(page);

  // Force the room-create POST to fail (GETs pass through untouched).
  await page.route('**/api/rooms', (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'forbidden (e2e)' }),
      });
    }
    return route.fallback();
  });

  await page.click('#create-room-btn');
  await expect(page.locator('#room-create-view')).toBeVisible();
  await page.fill('#room-create-name', 'Doomed Room');
  await page.check('#room-create-agent-ag-smoke');
  await page.click('#room-create-form button[type="submit"]');

  // Regression: error toasts must be role="alert" (assertive), not status.
  const toast = page.locator('#toasts .toast-error[role="alert"]');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('Failed to create room');
});

test('f. Escape closes the top layer (settings overlay)', async ({ page }) => {
  await enter(page);
  await page.click('#overflow-btn');
  await page.click('.overflow-item[data-action="settings"]');
  await expect(page.locator('#settings-overlay')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-overlay')).toBeHidden();
});
