import { test, expect, devices } from '@playwright/test';
import type { AddressInfo } from 'net';

/**
 * Connection-banner diagnosis — the three states a dropped socket can mean:
 *
 *   B  internet up, server unreachable → "check that Tailscale is connected"
 *      (+ an Open Tailscale action on mobile UAs)
 *   A  device offline                  → "You're offline…"
 *   C  path restored                   → banner clears on reconnect
 *
 * Deterministic and network-free: the WebSocket is refused via routeWebSocket
 * (flag-gated — WS routes can't be unrouted, so phase C flips the flag and
 * pipes through to the real server), the /generate_204 internet probes are
 * fulfilled locally, and /api/auth/info reports tailscale auth so the banner
 * uses the Tailscale wording. Mobile UA so the Open Tailscale action renders.
 */

// iPhone descriptor for the mobile UA (the Open Tailscale action is
// mobile-only) but keep chromium — webkit isn't installed in this repo's
// playwright setup and the UA string is all the banner logic reads.
test.use({ ...devices['iPhone 13'], browserName: 'chromium' });

let wc: { http: import('http').Server; host: string };
let baseURL = '';
let stop: () => Promise<void>;
let closeDb: () => void;

test.beforeAll(async () => {
  process.env.WEBCHAT_HOST = '127.0.0.1';
  process.env.WEBCHAT_PORT = '0';
  process.env.WEBCHAT_TOKEN = '';
  process.env.WEBCHAT_TAILSCALE = '';
  process.env.WEBCHAT_TRUSTED_PROXY_IPS = '';

  const conn = await import('../dist/db/connection.js');
  conn.initTestDb();
  const mig = await import('../dist/db/migrations/index.js');
  mig.runMigrations(conn.getDb());

  const srv = await import('../dist/channels/webchat/server.js');
  wc = await srv.startWebchatServer({ onInbound() {}, onAction() {} });
  baseURL = `http://127.0.0.1:${(wc.http.address() as AddressInfo).port}`;
  stop = () => srv.stopWebchatServer(wc);
  closeDb = () => conn.closeDb();
});

test.afterAll(async () => {
  if (stop) await stop();
  if (closeDb) closeDb();
});

test('diagnoses no-path / offline and clears on reconnect', async ({ page, context }) => {
  test.setTimeout(120_000);

  // Internet probes answer locally — the test never leaves the machine.
  await page.route('**/generate_204', (r) => r.fulfill({ status: 204 }));
  // Report tailscale auth so the diagnosis uses the Tailscale wording.
  await page.route('**/api/auth/info', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ methods: { tailscale: true } }) }),
  );

  // Refuse every WS while `refuse` holds; pipe through afterwards (WS routes
  // cannot be unrouted, so phase C needs the passthrough arm).
  let refuse = true;
  await page.routeWebSocket('**', (ws) => {
    if (refuse) {
      ws.close();
      return;
    }
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(m));
  });

  // The first-run setup wizard auto-opens for a fresh owner and its overlay
  // intercepts every click — report onboarding as complete so specs drive the
  // app, not the wizard.
  await page.route('**/api/webchat/onboarding', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ canEdit: false, complete: true }) }),
  );
  await page.goto(baseURL);
  const banner = page.locator('#connection-banner');

  // B — the socket never connects but the probes succeed.
  await expect(banner).toContainText('check that Tailscale is connected', { timeout: 15_000 });
  await expect(banner.locator('.banner-action')).toHaveText('Open Tailscale');

  // A — flip the device offline; the next retry's diagnosis must say so.
  await context.setOffline(true);
  await expect(banner).toContainText('You’re offline', { timeout: 15_000 });

  // C — restore the path; the reconnect (backoff-capped at 30s) clears it.
  await context.setOffline(false);
  refuse = false;
  await expect(banner).not.toHaveClass(/visible/, { timeout: 45_000 });
});
