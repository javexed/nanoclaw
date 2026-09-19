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

import os from 'os';

import { getTailscaleServeState } from '../../src/channels/web/tailscale-serve.js';
import { readEnvKey } from '../environment.js';

import { confirmThenOpen } from './browser.js';
import { reachInstructions, reachableWebUrl } from './web-reach.js';

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
  // Health is always checked on loopback — the server is local to setup even
  // when the operator is not, and a LAN/tailnet probe would fail for reasons
  // (firewall, split DNS) that say nothing about whether the server came up.
  const localUrl = `http://127.0.0.1:${port}/`;
  const up = await waitForWeb(`${localUrl}health`);

  const token = readEnvKey('WEB_TOKEN')?.trim() || null;
  const networkBound = (readEnvKey('WEB_HOST')?.trim() || '127.0.0.1') !== '127.0.0.1';
  const { url, kind } = reachableWebUrl({
    port,
    token,
    networkBound,
    hostAddress: networkBound ? primaryAddress() : null,
    tailscaleUrl: networkBound ? await tailscaleUrl() : null,
  });

  if (!up) {
    p.log.info(`Web UI: ${k.bold(url)}`);
    for (const line of reachInstructions({ port, token, networkBound, kind })) p.log.info(line);
    return false;
  }

  await confirmThenOpen(url, `Open ${k.bold(url)}?`);
  // After the open, not before: on a GUI box the browser is already taking
  // focus, and on a headless one confirmThenOpen has just printed the URL raw.
  // Either way the token is the next thing the operator needs.
  for (const line of reachInstructions({ port, token, networkBound, kind })) p.log.info(line);
  return true;
}

/** First non-internal IPv4 of this host — the address a LAN browser can use. */
function primaryAddress(): string | null {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

/** The tailnet HTTPS URL, when `tailscale serve` is already fronting this port. */
async function tailscaleUrl(): Promise<string | null> {
  try {
    const state = await getTailscaleServeState();
    return state.active ? state.url : null;
  } catch {
    return null;
  }
}
