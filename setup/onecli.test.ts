/**
 * The step DETECTS gateway /v1 compatibility and warns (pointing at
 * docs/onecli-upgrades.md) — it does not migrate the gateway; that's the
 * agent's job via /update-nanoclaw. The verify helper must distinguish
 * incompatible (pre-/v1 server: warn) from unreachable (transient: nothing to
 * say) so the warning only fires on a real pre-/v1 server.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { persistOnecliBindHost, verifyGatewayV1 } from './onecli.js';

function fakeFetch(behavior: 'ok' | '404' | 'down'): typeof fetch {
  return (async () => {
    if (behavior === 'down') throw new Error('ECONNREFUSED');
    return { ok: behavior === 'ok' } as Response;
  }) as unknown as typeof fetch;
}

describe('verifyGatewayV1', () => {
  it('ok when /v1/health answers', async () => {
    expect(await verifyGatewayV1('http://x', fakeFetch('ok'))).toBe('ok');
  });
  it('incompatible when the server answers HTTP without /v1', async () => {
    expect(await verifyGatewayV1('http://x', fakeFetch('404'))).toBe('incompatible');
  });
  it('unreachable on connection failure', async () => {
    expect(await verifyGatewayV1('http://x', fakeFetch('down'))).toBe('unreachable');
  });
});

describe('persistOnecliBindHost', () => {
  function tmpEnv(initial?: string): string {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-env-')), '.env');
    if (initial !== undefined) fs.writeFileSync(p, initial);
    return p;
  }

  it('pins the bridge host parsed from the gateway URL', () => {
    const p = tmpEnv('ONECLI_VERSION=1.37.0\n');
    persistOnecliBindHost('http://172.17.0.1:10254', p);
    expect(fs.readFileSync(p, 'utf-8')).toBe('ONECLI_VERSION=1.37.0\nONECLI_BIND_HOST=172.17.0.1\n');
  });

  it('creates the .env when absent and handles a missing trailing newline', () => {
    const p = tmpEnv(); // no file at all
    persistOnecliBindHost('http://172.17.0.1:10254', p);
    expect(fs.readFileSync(p, 'utf-8')).toBe('ONECLI_BIND_HOST=172.17.0.1\n');
    const p2 = tmpEnv('X=1'); // no trailing newline
    persistOnecliBindHost('http://172.17.0.1:10254', p2);
    expect(fs.readFileSync(p2, 'utf-8')).toBe('X=1\nONECLI_BIND_HOST=172.17.0.1\n');
  });

  it('never overwrites an existing operator value', () => {
    const p = tmpEnv('ONECLI_BIND_HOST=10.0.0.5\n');
    persistOnecliBindHost('http://172.17.0.1:10254', p);
    expect(fs.readFileSync(p, 'utf-8')).toBe('ONECLI_BIND_HOST=10.0.0.5\n');
  });

  it('skips loopback — nothing to protect', () => {
    const p = tmpEnv('X=1\n');
    persistOnecliBindHost('http://127.0.0.1:10254', p);
    expect(fs.readFileSync(p, 'utf-8')).toBe('X=1\n');
  });
});
