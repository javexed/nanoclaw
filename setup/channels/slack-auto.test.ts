import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  account: undefined as { api?: string; token: string } | undefined,
  installToken: undefined as string | undefined,
  notes: [] as Array<{ message: string; title: string }>,
  warns: [] as string[],
  runInheritScript: vi.fn(async () => 0),
  brokerListWorkspaces: vi.fn(async () => [
    { team_id: 'T0TEAM123', team_name: 'NanoCo', status: 'active', connected_as: 'U0OWNER12' },
  ]),
  brokerProvision: vi.fn(async () => ({
    appId: 'A0APP123',
    appToken: 'xapp-test',
    botToken: 'xoxb-test',
    installUrl: '',
  })),
}));

vi.mock('@clack/prompts', () => ({
  note: vi.fn((message: string, title: string) => state.notes.push({ message, title })),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  log: { warn: vi.fn((message: string) => state.warns.push(message)) },
}));

vi.mock('../logs.js', () => ({ userInput: vi.fn(), step: vi.fn() }));
vi.mock('../lib/bright-select.js', () => ({ brightSelect: vi.fn(async () => 'auto') }));
vi.mock('../lib/browser.js', () => ({ confirmThenOpen: vi.fn() }));
vi.mock('../lib/inherit-script.js', () => ({ runInheritScript: state.runInheritScript }));
vi.mock('../lib/registry-state.js', () => ({
  REGISTRY_LOGIN_SCRIPT: 'setup/registry-login.sh',
  imageSourceDecided: vi.fn(() => false),
  loginScriptAvailable: vi.fn(() => true),
  readImageSource: vi.fn(() => 'local'),
  readRegistryAccount: vi.fn(() => state.account),
  writeImageSource: vi.fn(),
}));
vi.mock('../lib/runner.js', () => ({ ensureAnswer: <T>(answer: T): T => answer }));
vi.mock('../lib/theme.js', () => ({ wrapForGutter: (message: string): string => message }));

import {
  PROVISIONING_MODULE,
  loadProvisioningCore,
  maybeAutoProvisionSlack,
  type ProvisioningCore,
} from './slack-auto.js';

/**
 * The provisioning core is NOT in this tree (it ships in the add-slack
 * channel payload), so the tests never import the real module: the fake
 * below stands in via the injectable importModule seam, and the bootstrap's
 * git commands go through the injectable exec — no fetch ever leaves a test.
 */
class FakeBrokerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`HTTP ${status}`);
  }
}

function fakeCore(): ProvisioningCore {
  return {
    BrokerHttpError: FakeBrokerHttpError,
    brokerListWorkspaces: state.brokerListWorkspaces,
    brokerOauthUrl: vi.fn(async () => ({ url: 'https://example.invalid/oauth' })),
    brokerProvision: state.brokerProvision,
    provisionManagedApp: vi.fn(async () => {
      throw new Error('unexpected direct provisioning');
    }),
    readInstallToken: vi.fn(() => state.installToken),
    readManagerToken: vi.fn(() => undefined),
  };
}

/** A root where the module already sits at its installed-tree path. */
function rootWithModule(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-auto-'));
  const modulePath = path.join(root, PROVISIONING_MODULE);
  fs.mkdirSync(path.dirname(modulePath), { recursive: true });
  fs.writeFileSync(modulePath, '// stand-in — tests inject importModule\n');
  return root;
}

const roots: string[] = [];
function track(root: string): string {
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('provisioning-core bootstrap', () => {
  beforeEach(() => {
    state.warns.length = 0;
  });

  it('module present in the tree: imports it, never touches git', async () => {
    const root = track(rootWithModule());
    const exec = vi.fn<(command: string) => string>();
    const core = fakeCore();
    const importModule = vi.fn(async () => core);

    await expect(loadProvisioningCore({ root, exec, importModule })).resolves.toBe(core);
    expect(exec).not.toHaveBeenCalled();
    expect(importModule).toHaveBeenCalledExactlyOnceWith(pathToFileURL(path.join(root, PROVISIONING_MODULE)).href);
  });

  it('module absent: fetches the channels branch and materializes the one file, engine-style', async () => {
    const root = track(fs.mkdtempSync(path.join(os.tmpdir(), 'slack-auto-')));
    const exec = vi.fn((command: string): string => {
      if (command === 'git remote') return 'upstream\norigin\n';
      if (command.startsWith('git ls-remote')) return 'abc123\trefs/heads/channels\n';
      return '';
    });
    const core = fakeCore();
    const importModule = vi.fn(async () => core);

    await expect(loadProvisioningCore({ root, exec, importModule })).resolves.toBe(core);
    // origin wins remote resolution even when listed after another remote
    expect(exec.mock.calls.map(([c]) => c)).toEqual([
      'git remote',
      'git ls-remote --heads origin channels',
      'git fetch origin channels',
      `git show origin/channels:${PROVISIONING_MODULE} > ${PROVISIONING_MODULE}`,
    ]);
    // the parent directory exists before the git show redirect runs
    expect(fs.existsSync(path.join(root, 'src/provisioning'))).toBe(true);
    expect(importModule).toHaveBeenCalledExactlyOnceWith(pathToFileURL(path.join(root, PROVISIONING_MODULE)).href);
  });

  it('module absent and the fetch fails (offline / no branch): resolves undefined, never imports', async () => {
    const root = track(fs.mkdtempSync(path.join(os.tmpdir(), 'slack-auto-')));
    const exec = vi.fn((): string => {
      throw new Error('could not read from remote repository');
    });
    const importModule = vi.fn(async () => fakeCore());

    await expect(loadProvisioningCore({ root, exec, importModule })).resolves.toBeUndefined();
    expect(importModule).not.toHaveBeenCalled();
  });

  it('bootstrap failure degrades the pre-step to the manual path with one warning line', async () => {
    const root = track(fs.mkdtempSync(path.join(os.tmpdir(), 'slack-auto-')));
    const exec = vi.fn((): string => {
      throw new Error('could not read from remote repository');
    });

    await expect(maybeAutoProvisionSlack('Trusty', { root, exec })).resolves.toBeUndefined();
    expect(state.warns).toEqual([
      "Couldn't load the Slack provisioning module — walking through manual app creation instead.",
    ]);
  });

  it('runtime probe: tsx imports a fetched .ts module file directly', () => {
    const root = track(rootWithModule());
    const modulePath = path.join(root, PROVISIONING_MODULE);
    fs.writeFileSync(
      modulePath,
      [
        '// TypeScript-only syntax on purpose: a plain-JS loader would reject this file.',
        'export interface Probe { value: string }',
        'export function readManagerToken(): string {',
        "  const probe: Probe = { value: 'loaded-ts' };",
        '  return probe.value;',
        '}',
        '',
      ].join('\n'),
    );
    const probePath = path.join(root, 'probe.ts');
    fs.writeFileSync(
      probePath,
      `import(${JSON.stringify(pathToFileURL(modulePath).href)}).then((m) => process.stdout.write(m.readManagerToken()));\n`,
    );
    const tsxBin = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
    const result = spawnSync(tsxBin, [probePath], { encoding: 'utf-8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('loaded-ts');
  });
});

describe('Slack managed-app sign-in', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.notes.length = 0;
    state.warns.length = 0;
    state.installToken = 'nct-saved';
    state.account = {
      token: 'nct-saved',
      api: 'https://user:password@registry.sandbox.nanoclaw.dev/private?token=secret',
    };
  });

  it('validates a saved credential before using it and shows only its service origin', async () => {
    const root = track(rootWithModule());
    const core = fakeCore();
    const result = await maybeAutoProvisionSlack('Trusty', { root, importModule: async () => core });

    expect(state.runInheritScript).toHaveBeenCalledOnce();
    expect(state.runInheritScript).toHaveBeenCalledWith('bash', ['setup/registry-login.sh']);
    expect(state.brokerListWorkspaces).toHaveBeenCalledWith('nct-saved');
    expect(result).toMatchObject({
      connection: 'provisioned',
      bot_token: 'xoxb-test',
      app_token: 'xapp-test',
      owner_handle: 'U0OWNER12',
    });

    expect(state.notes).toEqual([
      {
        title: 'NanoClaw sign-in',
        message: [
          'Found saved NanoClaw credentials.',
          'Service: https://registry.sandbox.nanoclaw.dev',
          'Checking whether they are valid for this setup…',
        ].join('\n'),
      },
    ]);
    expect(state.notes[0].message).not.toContain('password');
    expect(state.notes[0].message).not.toContain('secret');
  });
});
