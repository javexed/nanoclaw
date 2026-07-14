/**
 * Tests for the `tailscale serve` control module — state probing and the
 * failure-classification that drives the "Enable HTTPS over Tailscale" UI.
 * All tailscale calls go through an injected runner, so no daemon is needed.
 */
import { describe, it, expect } from 'vitest';

import {
  getTailscaleServeState,
  enableTailscaleServe,
  type RunResult,
  type TailscaleRunner,
} from './tailscale-serve.js';

const ok = (stdout = ''): RunResult => ({ ok: true, notFound: false, stdout, stderr: '' });
const fail = (stderr = '', stdout = ''): RunResult => ({ ok: false, notFound: false, stdout, stderr });

/** Build a runner that dispatches on the first arg / subcommand. */
function runner(map: Partial<Record<string, RunResult>>, fallback: RunResult = fail('unmapped')): TailscaleRunner {
  return async (args) => {
    const key = args.join(' ');
    return map[key] ?? fallback;
  };
}

const STATUS_UP = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'node.tailnet.ts.net.' } });

describe('getTailscaleServeState', () => {
  it('reports available + url + active from a running daemon with a serve mapping', async () => {
    const state = await getTailscaleServeState(
      runner({
        'status --json': ok(STATUS_UP),
        'serve status --json': ok(JSON.stringify({ Web: { 'node.tailnet.ts.net:443': {} } })),
      }),
    );
    expect(state).toEqual({ available: true, active: true, url: 'https://node.tailnet.ts.net' });
  });

  it('strips the trailing dot from the MagicDNS name', async () => {
    const state = await getTailscaleServeState(
      runner({ 'status --json': ok(STATUS_UP), 'serve status --json': ok('{}') }),
    );
    expect(state.url).toBe('https://node.tailnet.ts.net');
    expect(state.active).toBe(false);
  });

  it('reports unavailable when `tailscale status` fails', async () => {
    const state = await getTailscaleServeState(runner({ 'status --json': fail('stopped') }));
    expect(state).toEqual({ available: false, active: false, url: null });
  });

  it('still reports available when the serve-status subcommand is unsupported (older CLI)', async () => {
    const state = await getTailscaleServeState(
      runner({ 'status --json': ok(STATUS_UP), 'serve status --json': fail('unknown flag: --json') }),
    );
    expect(state).toEqual({ available: true, active: false, url: 'https://node.tailnet.ts.net' });
  });
});

describe('enableTailscaleServe', () => {
  it('refuses when tailscale is down', async () => {
    const r = await enableTailscaleServe(3100, runner({ 'status --json': fail('stopped') }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not running or not logged in/i);
  });

  it('runs `serve --bg <port>` and returns the https url on success', async () => {
    const r = await enableTailscaleServe(
      3100,
      runner({
        'status --json': ok(STATUS_UP),
        'serve status --json': ok('{}'),
        'serve --bg 3100': ok(''),
      }),
    );
    expect(r).toEqual({ ok: true, url: 'https://node.tailnet.ts.net' });
  });

  it('classifies the certs-not-enabled failure with the admin link', async () => {
    const r = await enableTailscaleServe(
      3100,
      runner({
        'status --json': ok(STATUS_UP),
        'serve status --json': ok('{}'),
        'serve --bg 3100': fail('HTTPS is not enabled on the tailnet; enable it in the admin console'),
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/certificates are not enabled/i);
    expect(r.hintUrl).toBe('https://login.tailscale.com/admin/dns');
  });

  it('classifies a permission / operator failure', async () => {
    const r = await enableTailscaleServe(
      3100,
      runner({
        'status --json': ok(STATUS_UP),
        'serve status --json': ok('{}'),
        'serve --bg 3100': fail('access denied: this operation requires operator access'),
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.hint).toMatch(/operator/i);
  });

  it('handles a missing tailscale binary', async () => {
    const notFound: RunResult = { ok: false, notFound: true, stdout: '', stderr: '' };
    const r = await enableTailscaleServe(
      3100,
      runner({ 'status --json': ok(STATUS_UP), 'serve status --json': ok('{}'), 'serve --bg 3100': notFound }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not installed/i);
  });
});
