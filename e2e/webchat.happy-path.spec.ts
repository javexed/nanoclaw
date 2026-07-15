import { test, expect } from '@playwright/test';
import type { AddressInfo } from 'net';

/**
 * Webchat happy path — the frontend's first automated coverage.
 *
 * Boots the REAL webchat server in-process from built `dist/`, with NO-OP hooks:
 * a sent message is stored + broadcast over the WS (so it renders) but never
 * routes to the router/Docker/LLM. The agent reply is injected exactly the way
 * real delivery does — storeWebchatMessage('agent') + broadcast — i.e. a genuine
 * agent message on the wire, deterministic and credential-free.
 *
 * Auth on loopback "always passes" (see auth.ts), so the login form is bypassed
 * locally; the login step below runs only if the form is actually shown. The
 * load-bearing coverage is the in-app loop: enter → create room → send → render
 * the user message → render an agent reply.
 *
 * Run via `pnpm run e2e` (builds dist first). Imports resolve against dist/.
 */

// Bind loopback with NO token: the server treats loopback as authenticated (the
// legitimate localhost case), so static, /api, AND the WebSocket upgrade all
// pass without credentials — and the browser can't set an Authorization header
// on a WS upgrade anyway. The first loopback identity is auto-granted owner, so
// room creation is allowed.

// dist is plain ESM JS; import dynamically AFTER env is set so config.ts picks it up.
let wc: { http: import('http').Server; host: string };
let baseURL = '';
let inject: (roomId: string, text: string) => void;
let getRooms: () => Array<{ id: string; name: string }>;
let stop: () => Promise<void>;
let closeDb: () => void;

test.beforeAll(async () => {
  process.env.WEBCHAT_HOST = '127.0.0.1';
  process.env.WEBCHAT_PORT = '0'; // ephemeral
  process.env.WEBCHAT_TOKEN = ''; // none → loopback is trusted (HTTP + WS)
  process.env.WEBCHAT_TAILSCALE = '';
  process.env.WEBCHAT_TRUSTED_PROXY_IPS = '';

  const conn = await import('../dist/db/connection.js');
  conn.initTestDb();
  const mig = await import('../dist/db/migrations/index.js');
  mig.runMigrations(conn.getDb());

  // Seed an agent group so the room-create form offers a selectable agent.
  const ag = await import('../dist/db/agent-groups.js');
  ag.createAgentGroup({
    id: 'ag-e2e',
    name: 'E2E Agent',
    folder: 'e2e-agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  } as Parameters<typeof ag.createAgentGroup>[0]);

  const srv = await import('../dist/channels/webchat/server.js');
  wc = await srv.startWebchatServer({ onInbound() {}, onAction() {} });
  baseURL = `http://127.0.0.1:${(wc.http.address() as AddressInfo).port}`;

  const db = await import('../dist/channels/webchat/db.js');
  const state = await import('../dist/channels/webchat/state.js');
  inject = (roomId, text) => {
    const stored = db.storeWebchatMessage(roomId, 'E2E Agent', 'agent', text);
    state.broadcast(roomId, { type: 'message', ...stored });
  };
  getRooms = () => db.getAllWebchatRooms() as Array<{ id: string; name: string }>;
  stop = () => srv.stopWebchatServer(wc);
  closeDb = () => conn.closeDb();
});

test.afterAll(async () => {
  if (stop) await stop();
  if (closeDb) closeDb();
});

test('enter app, create a room, send a message, see an agent reply', async ({ page }) => {
  // The first-run setup wizard auto-opens for a fresh owner and its overlay
  // intercepts every click — report onboarding as complete so specs drive the
  // app, not the wizard.
  await page.route('**/api/webchat/onboarding', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ canEdit: false, complete: true }) }),
  );
  await page.goto(baseURL);

  // Loopback bypasses auth; only drive the login form if it's actually shown.
  const login = page.locator('#login-screen');
  if (await login.isVisible().catch(() => false)) {
    await page.fill('#login-token', process.env.WEBCHAT_TOKEN!);
    await page.click('#login-form button[type="submit"]');
  }
  await expect(page.locator('#create-room-btn')).toBeVisible();

  // Create a room wired to the seeded agent.
  await page.click('#create-room-btn');
  await expect(page.locator('#room-create-view')).toBeVisible();
  await page.fill('#room-create-name', 'E2E Room');
  await page.check('#room-create-agent-ag-e2e'); // the seeded agent's checkbox
  await page.click('#room-create-form button[type="submit"]');

  // Joining the new room enables the composer.
  await expect(page.locator('#message-input')).toBeEnabled();

  // Resolve the created room's id (server-side) for the agent-reply injection.
  const roomId = getRooms().find((r) => r.name === 'E2E Room')?.id;
  expect(roomId, 'created room should exist').toBeTruthy();

  // Send a user message → optimistic + echoed render.
  await page.fill('#message-input', 'hello from e2e');
  await page.click('#send-btn');
  await expect(page.locator('#messages')).toContainText('hello from e2e');

  // Inject an agent reply exactly like real delivery → it renders as an agent msg.
  inject(roomId!, 'pong from the agent');
  await expect(page.locator('#messages .msg.agent')).toContainText('pong from the agent');

  // Topology view renders the room → agent graph from /api/topology.
  await test.step('topology renders the room → agent graph', async () => {
    await page.click('#overflow-btn');
    await page.click('.overflow-item[data-action="topology"]');
    await expect(page.locator('#topology .topo-room')).toContainText('E2E Room');
    await expect(page.locator('#topology .topo-agent')).toContainText('E2E Agent');
  });

  // Wiring matrix: the seeded room↔agent wiring shows as one "on" cell.
  await test.step('wiring matrix shows the room↔agent cell as on', async () => {
    await page.click('#overflow-btn');
    await page.click('.overflow-item[data-action="wiring"]');
    await expect(page.locator('#matrix .matrix-agent-name')).toContainText('E2E Agent');
    await expect(page.locator('#matrix .matrix-cell.on')).toHaveCount(1);
  });
});
