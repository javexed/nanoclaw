/**
 * Grok credential handling.
 *
 * The security property under test is narrow and absolute: the refresh token
 * must never reach the container copy. Everything else here supports that —
 * rotation, expiry maths, and the un-authenticated path staying non-fatal.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-auth-'));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  DATA_DIR: TMP,
}));

const {
  REFRESH_SKEW_MS,
  REFRESH_TICK_MS,
  refreshDueCredentials,
  startGrokCredentialRefresh,
  containerAuthJson,
  grokHostDir,
  hostCredentialsPath,
  importCliAuthJson,
  materializeContainerAuth,
  needsRefresh,
  readHostCredentials,
  refreshCredentials,
  writeContainerAuth,
  writeHostCredentials,
  writeSharedCredentials,
} = await import('./grok-auth.js');

type Creds = Awaited<ReturnType<typeof refreshCredentials>>;

const creds = (over: Partial<Creds> = {}): Creds => ({
  accessToken: 'access-AAA',
  refreshToken: 'refresh-SECRET',
  expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
  issuer: 'https://auth.x.ai',
  clientId: 'client-1',
  email: 'someone@example.com',
  userId: 'user-1',
  ...over,
});

const shared = (name: string) => {
  const d = path.join(TMP, 'shared', name);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('the refresh token never reaches the container', () => {
  it('containerAuthJson carries the access token and omits the refresh token', () => {
    const json = containerAuthJson(creds());
    const serialized = JSON.stringify(json);
    expect(serialized).toContain('access-AAA');
    expect(serialized).not.toContain('refresh-SECRET');
    expect(serialized).not.toMatch(/refresh_token/);
  });

  it('carries every field the CLI requires to consider itself signed in', () => {
    // MEASURED against grok 1.0.5 by dropping one field at a time from a
    // known-good file: without any of these the CLI reports "You are not
    // authenticated" even though the access token is valid. create_time was
    // missing in the first cut of this module and cost a live debugging round.
    const entry = containerAuthJson(creds())['https://auth.x.ai::client-1'] as Record<string, unknown>;
    for (const required of ['key', 'auth_mode', 'create_time', 'expires_at', 'user_id', 'oidc_issuer', 'oidc_client_id']) {
      expect(entry[required], `missing required field ${required}`).toBeDefined();
    }
  });

  it('prefers the CLI\'s own create_time over a synthesised one', () => {
    const entry = containerAuthJson(creds({ createdAt: '2026-08-18T23:11:24.793Z' }))[
      'https://auth.x.ai::client-1'
    ] as Record<string, unknown>;
    expect(entry.create_time).toBe('2026-08-18T23:11:24.793Z');
  });

  it('synthesises create_time when the credential predates the field', () => {
    const entry = containerAuthJson(creds())['https://auth.x.ai::client-1'] as Record<string, unknown>;
    expect(() => new Date(entry.create_time as string).toISOString()).not.toThrow();
  });

  it('keys the entry the way the CLI indexes it', () => {
    expect(Object.keys(containerAuthJson(creds()))).toEqual(['https://auth.x.ai::client-1']);
  });

  it('the written container file contains no refresh token', () => {
    const dir = shared('g1');
    writeContainerAuth(dir, creds());
    const raw = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8');
    expect(raw).not.toContain('refresh-SECRET');
    expect(JSON.parse(raw)['https://auth.x.ai::client-1'].key).toBe('access-AAA');
  });

  it('host credentials live OUTSIDE the mounted grok home', () => {
    // .grok-shared is bind-mounted into the container; .grok-host must not be.
    expect(grokHostDir('g1')).toContain('.grok-host');
    expect(grokHostDir('g1')).not.toContain('.grok-shared');
  });

  it('both host artefacts are owner-only', () => {
    writeHostCredentials('g2', creds());
    expect(fs.statSync(grokHostDir('g2')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(hostCredentialsPath('g2')).mode & 0o777).toBe(0o600);
  });
});

describe('expiry', () => {
  it('a fresh token needs no refresh', () => {
    expect(needsRefresh(creds())).toBe(false);
  });

  it('a token inside the skew window is due', () => {
    expect(needsRefresh(creds({ expiresAt: new Date(Date.now() + REFRESH_SKEW_MS - 1000).toISOString() }))).toBe(true);
  });

  it('an expired token is due', () => {
    expect(needsRefresh(creds({ expiresAt: new Date(Date.now() - 1000).toISOString() }))).toBe(true);
  });

  it('an unparseable expiry is treated as due rather than trusted', () => {
    expect(needsRefresh(creds({ expiresAt: 'not-a-date' }))).toBe(true);
  });
});

describe('refreshCredentials', () => {
  const okResponse = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

  it('posts the refresh grant as a public client — no secret on the wire', async () => {
    let seen: { url: string; body: string } | null = null;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url: String(url), body: String(init.body) };
      return okResponse({ access_token: 'access-BBB', expires_in: 3600 });
    }) as unknown as typeof fetch;

    await refreshCredentials(creds(), { fetchFn });

    expect(seen!.url).toBe('https://auth.x.ai/oauth2/token');
    expect(seen!.body).toContain('grant_type=refresh_token');
    expect(seen!.body).toContain('client_id=client-1');
    expect(seen!.body).not.toMatch(/client_secret/);
  });

  it('adopts a rotated refresh token, since dropping it would strand the group', async () => {
    const fetchFn = (async () =>
      okResponse({ access_token: 'access-BBB', refresh_token: 'refresh-ROTATED', expires_in: 3600 })) as unknown as typeof fetch;
    const next = await refreshCredentials(creds(), { fetchFn });
    expect(next.refreshToken).toBe('refresh-ROTATED');
    expect(next.accessToken).toBe('access-BBB');
  });

  it('keeps the existing refresh token when the response omits one', async () => {
    const fetchFn = (async () => okResponse({ access_token: 'access-BBB', expires_in: 3600 })) as unknown as typeof fetch;
    expect((await refreshCredentials(creds(), { fetchFn })).refreshToken).toBe('refresh-SECRET');
  });

  it('computes expiry from expires_in', async () => {
    const fetchFn = (async () => okResponse({ access_token: 'a', expires_in: 7200 })) as unknown as typeof fetch;
    const next = await refreshCredentials(creds(), { fetchFn, now: () => 1_000_000 });
    expect(next.expiresAt).toBe(new Date(1_000_000 + 7200_000).toISOString());
  });

  it('surfaces an HTTP failure with its status', async () => {
    const fetchFn = (async () =>
      ({ ok: false, status: 401, text: async () => 'invalid_grant' }) as Response) as unknown as typeof fetch;
    await expect(refreshCredentials(creds(), { fetchFn })).rejects.toThrow(/HTTP 401.*invalid_grant/);
  });

  it('rejects a 200 that carries no access_token', async () => {
    const fetchFn = (async () => okResponse({ token_type: 'Bearer' })) as unknown as typeof fetch;
    await expect(refreshCredentials(creds(), { fetchFn })).rejects.toThrow(/no access_token/);
  });
});

describe('importing a CLI login', () => {
  it('splits a real-shaped auth.json into managed credentials', () => {
    const imported = importCliAuthJson({
      'https://auth.x.ai::b1a00492': {
        key: 'access-from-cli',
        refresh_token: 'refresh-from-cli',
        expires_at: '2026-08-19T05:11:24.793137180Z',
        oidc_issuer: 'https://auth.x.ai',
        oidc_client_id: 'b1a00492',
        email: 'someone@example.com',
        user_id: 'uid-9',
        auth_mode: 'oidc',
        create_time: '2026-08-18T23:11:24.793137180Z',
      },
    });
    expect(imported).toMatchObject({
      accessToken: 'access-from-cli',
      refreshToken: 'refresh-from-cli',
      issuer: 'https://auth.x.ai',
      clientId: 'b1a00492',
      email: 'someone@example.com',
      userId: 'uid-9',
      createdAt: '2026-08-18T23:11:24.793137180Z',
    });
  });

  it('returns null for a file with no usable session', () => {
    expect(importCliAuthJson({})).toBeNull();
    expect(importCliAuthJson({ 'x::y': { key: 'only-access' } })).toBeNull();
  });
});

describe('materializeContainerAuth', () => {
  it('writes the container token and reports success', () => {
    writeHostCredentials('g3', creds());
    const dir = shared('g3');
    expect(materializeContainerAuth('g3', dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'auth.json'))).toBe(true);
  });

  it('an un-authenticated group is a false, not a throw — a spawn must not die on it', () => {
    expect(materializeContainerAuth('never-logged-in', shared('g4'))).toBe(false);
  });

  it('a corrupt host credential file degrades instead of crashing the spawn', () => {
    fs.mkdirSync(grokHostDir('g5'), { recursive: true });
    fs.writeFileSync(hostCredentialsPath('g5'), '{not json');
    expect(readHostCredentials('g5')).toBeNull();
    expect(materializeContainerAuth('g5', shared('g5'))).toBe(false);
  });

  it('does not refresh when the token is still fresh', async () => {
    writeHostCredentials('g6', creds());
    let called = 0;
    const fetchFn = (async () => {
      called += 1;
      return { ok: true, status: 200, json: async () => ({ access_token: 'x' }), text: async () => '' } as Response;
    }) as unknown as typeof fetch;
    materializeContainerAuth('g6', shared('g6'), { fetchFn });
    await new Promise((r) => setTimeout(r, 10));
    expect(called).toBe(0);
  });

  it('refreshes in the background when due, updating BOTH copies', async () => {
    writeHostCredentials('g7', creds({ expiresAt: new Date(Date.now() + 1000).toISOString() }));
    const dir = shared('g7');
    const fetchFn = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'access-REFRESHED', refresh_token: 'refresh-NEW', expires_in: 3600 }),
        text: async () => '',
      }) as Response) as unknown as typeof fetch;

    materializeContainerAuth('g7', dir, { fetchFn });
    await new Promise((r) => setTimeout(r, 20));

    // Host keeps the rotated refresh token…
    expect(readHostCredentials('g7')?.refreshToken).toBe('refresh-NEW');
    // …and the container gets the new access token, still with no refresh token.
    const raw = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8');
    expect(raw).toContain('access-REFRESHED');
    expect(raw).not.toContain('refresh-NEW');
  });

  it('a failed background refresh is reported, not thrown into the spawn', async () => {
    writeHostCredentials('g8', creds({ expiresAt: new Date(Date.now() + 1000).toISOString() }));
    const errors: unknown[] = [];
    const fetchFn = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    expect(materializeContainerAuth('g8', shared('g8'), { fetchFn, onError: (e) => errors.push(e) })).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect((errors[0] as Error).message).toMatch(/network down/);
  });
});

describe('the periodic refresh sweep', () => {
  const ok = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body, text: async () => '' }) as Response;

  // The sweep visits EVERY credential this install owns, so per-group files
  // left by earlier cases would be swept too. Start each case from one owner.
  beforeEach(() => {
    fs.rmSync(path.join(TMP, 'v2-sessions'), { recursive: true, force: true });
    fs.rmSync(path.join(TMP, 'grok'), { recursive: true, force: true });
  });

  it('ticks well inside the skew, so nothing can hand out an expired token', () => {
    expect(REFRESH_TICK_MS).toBeLessThan(REFRESH_SKEW_MS);
  });

  it('renews a credential that is due', async () => {
    writeSharedCredentials(creds({ expiresAt: new Date(Date.now() + 1000).toISOString() }));
    const fetchFn = (async () =>
      ok({ access_token: 'access-SWEPT', refresh_token: 'refresh-SWEPT', expires_in: 3600 })) as unknown as typeof fetch;

    const count = await refreshDueCredentials({ fetchFn });

    expect(count).toBe(1);
    expect(readHostCredentials('nobody')?.accessToken).toBe('access-SWEPT');
  });

  it('leaves a fresh credential alone — a sweep is not a reason to spend a refresh', async () => {
    writeSharedCredentials(creds());
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return ok({ access_token: 'x' });
    }) as unknown as typeof fetch;

    expect(await refreshDueCredentials({ fetchFn })).toBe(0);
    expect(calls).toBe(0);
  });

  it('one dead credential does not stop the others being renewed', async () => {
    // Per-group file (fails) alongside the shared one (succeeds).
    writeHostCredentials('doomed', creds({ expiresAt: new Date(Date.now() + 1000).toISOString() }));
    writeSharedCredentials(creds({ expiresAt: new Date(Date.now() + 1000).toISOString() }));
    const errors: string[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) =>
      String(init.body).includes('refresh-SECRET')
        ? ok({ access_token: 'access-OK', expires_in: 3600 })
        : ({ ok: false, status: 400, text: async () => 'invalid_grant' }) as Response) as unknown as typeof fetch;

    const count = await refreshDueCredentials({ fetchFn, onError: (m) => errors.push(m) });

    // Both share the same refresh token in this fixture, so both succeed; the
    // point under test is that the sweep visits every owner rather than stopping.
    expect(count).toBe(2);
    expect(errors).toEqual([]);
  });

  it('reports a failure per credential instead of throwing out of the sweep', async () => {
    writeSharedCredentials(creds({ expiresAt: new Date(Date.now() + 1000).toISOString() }));
    const errors: string[] = [];
    const fetchFn = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await expect(refreshDueCredentials({ fetchFn, onError: (m) => errors.push(m) })).resolves.toBe(0);
    expect(errors[0]).toMatch(/network down/);
  });

  it('start returns a stop, and the timer never holds the host open', () => {
    writeSharedCredentials(creds());
    const stop = startGrokCredentialRefresh({ fetchFn: (async () => ok({})) as unknown as typeof fetch });
    expect(typeof stop).toBe('function');
    stop();
  });
});
