/**
 * End-of-setup hand-off to the web UI. The service step reports "running" when
 * the host process is up, but the web server binds a beat later — opening the
 * browser immediately shows "connection refused". So: wait for /health, then
 * offer the open through the same confirm-gated, headless-aware helper every
 * channel flow uses (lib/browser.ts). Best-effort throughout: a slow or absent
 * server degrades to printing the URL, never to a failed setup.
 */
import * as p from '@clack/prompts';
import k from 'kleur';

import { confirmThenOpen } from './browser.js';

/** Poll `url` until it answers 2xx, or `timeoutMs` elapses. */
export async function waitForWeb(url: string, timeoutMs = 20_000, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(intervalMs) });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return false;
}

/**
 * Offer to open the freshly enabled web UI. Returns true when the server
 * answered and the offer was made (the caller uses it to pick the outro);
 * false when the server never came up — then the URL is printed instead.
 */
export async function offerToOpenWeb(port: string): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/`;
  const up = await waitForWeb(`${url}health`);
  if (!up) {
    p.log.info(`Web UI: ${k.bold(url)}`);
    return false;
  }
  await confirmThenOpen(url, `Open ${k.bold(url)}?`);
  return true;
}
