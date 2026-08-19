/**
 * Grok setup surface.
 *
 * The case that matters most is the one that has no daemon in it: the login
 * writes a FULL auth.json (refresh token included) to a temp dir, and that copy
 * must be imported and destroyed rather than handed to a container.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-setup-'));

vi.mock('../../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config.js')>()),
  DATA_DIR: TMP,
}));

const { buildDeviceLoginArgs, checkGrokInstall, importLoginResult, runGrokAuth, GROK_BARRELS, GROK_PAYLOAD_FILES } =
  await import('./grok.js');
const { getSetupProvider, listSetupProviders } = await import('./registry.js');
const { readHostCredentials, sharedCredentialsPath } = await import('../../src/providers/grok-auth.js');

const CLI_AUTH = {
  'https://auth.x.ai::client-9': {
    key: 'access-XYZ',
    refresh_token: 'refresh-SECRET',
    expires_at: '2026-08-19T05:11:24.793Z',
    oidc_issuer: 'https://auth.x.ai',
    oidc_client_id: 'client-9',
    email: 'someone@example.com',
    auth_mode: 'oidc',
  },
};

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('picker registration', () => {
  it('appears in the picker with a hint naming the subscription, not an API key', () => {
    const entry = getSetupProvider('grok');
    expect(entry?.label).toBe('Grok');
    expect(entry?.hint).toMatch(/subscription/i);
    // It should say an API key is NOT needed, never offer one as the path.
    expect(entry?.hint).toMatch(/no API key/i);
  });

  it('is resolvable case-insensitively and owns both hooks', () => {
    expect(getSetupProvider('GROK')?.value).toBe('grok');
    expect(getSetupProvider('grok')?.runAuth).toBeTypeOf('function');
    expect(getSetupProvider('grok')?.runInstallCheck).toBeTypeOf('function');
  });

  it('does not displace claude as the default entry', () => {
    expect(listSetupProviders()[0].value).toBe('claude');
  });
});

describe('device login command', () => {
  const args = buildDeviceLoginArgs('img:latest', '/tmp/authdir');

  it('mounts the host dir at the CLI home so the credential lands on the host', () => {
    expect(args).toContain('-v');
    expect(args).toContain('/tmp/authdir:/home/node/.grok');
  });

  it('resolves the CLI from PATH, never from under the mounted home', () => {
    // ~/.grok/bin/grok would be hidden by the mount — the collision this
    // provider exists to avoid.
    const entry = args[args.indexOf('--entrypoint') + 1];
    expect(entry).toBe('grok');
    expect(args.join(' ')).not.toContain('/home/node/.grok/bin');
  });

  it('is a throwaway, interactive, and immune to a background self-update', () => {
    expect(args).toContain('--rm');
    expect(args).toContain('-i');
    expect(args).toContain('--no-auto-update');
    expect(args.slice(-2)).toEqual(['login', '--device-auth']);
  });
});

describe('importing the login result', () => {
  it('reads a CLI-written auth.json', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'ok-'));
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(CLI_AUTH));
    expect(importLoginResult(dir)).toMatchObject({ accessToken: 'access-XYZ', refreshToken: 'refresh-SECRET' });
  });

  it('returns null when the login never wrote one, or wrote junk', () => {
    expect(importLoginResult(fs.mkdtempSync(path.join(TMP, 'empty-')))).toBeNull();
    const bad = fs.mkdtempSync(path.join(TMP, 'bad-'));
    fs.writeFileSync(path.join(bad, 'auth.json'), '{not json');
    expect(importLoginResult(bad)).toBeNull();
  });
});

describe('runGrokAuth', () => {
  it('stores the credential install-wide and destroys the temp copy', async () => {
    let mountedDir = '';
    await runGrokAuth({
      projectRoot: process.cwd(),
      log: () => {},
      runDocker: (args) => {
        mountedDir = args[args.indexOf('-v') + 1].split(':')[0];
        fs.writeFileSync(path.join(mountedDir, 'auth.json'), JSON.stringify(CLI_AUTH));
      },
    });

    expect(readHostCredentials('any-group')).toMatchObject({ accessToken: 'access-XYZ' });
    // The temp copy held a live refresh token and must not survive.
    expect(fs.existsSync(mountedDir)).toBe(false);
  });

  it('the stored shared credential is owner-only', async () => {
    expect(fs.statSync(sharedCredentialsPath()).mode & 0o777).toBe(0o600);
  });

  it('a login that produced nothing fails loudly, and still cleans up', async () => {
    let dir = '';
    await expect(
      runGrokAuth({
        log: () => {},
        runDocker: (args) => {
          dir = args[args.indexOf('-v') + 1].split(':')[0];
        },
      }),
    ).rejects.toThrow(/did not produce a usable session/);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('a docker failure cleans up rather than leaking the temp credential dir', async () => {
    let dir = '';
    await expect(
      runGrokAuth({
        log: () => {},
        runDocker: (args) => {
          dir = args[args.indexOf('-v') + 1].split(':')[0];
          throw new Error('docker: daemon not running');
        },
      }),
    ).rejects.toThrow(/daemon not running/);
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe('install check', () => {
  it('passes on a fully wired tree', async () => {
    await expect(checkGrokInstall(process.cwd())).resolves.toBeUndefined();
  });

  it('names the missing payload files', async () => {
    const bare = fs.mkdtempSync(path.join(TMP, 'bare-'));
    await expect(checkGrokInstall(bare)).rejects.toThrow(/payload incomplete/);
  });

  it('catches a payload whose barrels were never wired', async () => {
    const root = fs.mkdtempSync(path.join(TMP, 'unwired-'));
    for (const f of GROK_PAYLOAD_FILES) {
      fs.mkdirSync(path.join(root, path.dirname(f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), '// payload');
    }
    for (const { file } of GROK_BARRELS) {
      fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), '// barrel with no grok import\n');
    }
    await expect(checkGrokInstall(root)).rejects.toThrow(/not registered in/);
  });
});
