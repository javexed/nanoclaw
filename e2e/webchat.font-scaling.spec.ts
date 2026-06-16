import { test, expect } from '@playwright/test';
import type { AddressInfo } from 'net';

/**
 * Font-size scaling guard (px→rem regression).
 *
 * The Settings Small/Medium/Large control sets the *root* font-size; rem-based
 * chrome must scale with it. Before the px→rem conversion, fixed-px chrome
 * (sidebar, forms, labels) silently ignored the setting. This test flips the
 * control through the real UI and asserts a piece of explicitly-sized chrome
 * (`.setting-label`, `font-size: 0.8rem`) actually grows and shrinks.
 *
 * Same in-process boot as the happy-path spec; loopback is trusted so no token.
 * Run via `pnpm run e2e` (builds dist first).
 */

let wc: { http: import('http').Server; host: string };
let baseURL = '';
let stop: () => Promise<void>;
let closeDb: () => void;

test.beforeAll(async () => {
  process.env.WEBCHAT_HOST = '127.0.0.1';
  process.env.WEBCHAT_PORT = '0'; // ephemeral
  process.env.WEBCHAT_TOKEN = ''; // none → loopback trusted
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

test('Small/Medium/Large scales rem-based chrome (px→rem regression)', async ({ page }) => {
  await page.goto(baseURL);
  await expect(page.locator('#create-room-btn')).toBeVisible();

  // Open Settings via the overflow menu.
  await page.click('#overflow-btn');
  await page.click('.overflow-item[data-action="settings"]');
  await expect(page.locator('#settings-overlay')).toBeVisible();

  // Explicitly-sized chrome (font-size: 0.8rem) — exactly what ignored the
  // setting before the conversion. Measure its computed px at each step.
  const label = page.locator('.setting-label').first();
  const fontPx = () => label.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const pick = (value: string) => page.click(`#font-options .setting-option[data-value="${value}"]`);

  await pick('medium');
  const med = await fontPx();
  await pick('large');
  const lg = await fontPx();
  await pick('small');
  const sm = await fontPx();

  // It must move in the right direction…
  expect(lg).toBeGreaterThan(med);
  expect(sm).toBeLessThan(med);

  // …and track the 13/15/17 root scale (the rem base), within rounding.
  expect(lg / med).toBeCloseTo(17 / 15, 1);
  expect(sm / med).toBeCloseTo(13 / 15, 1);
});
