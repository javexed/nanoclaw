/**
 * Grok host contribution.
 *
 * The mount is the whole point: without a persistent ~/.grok, every container
 * restart invalidates every stored continuation, because Grok resolves the
 * sessionId against its own on-disk store. That failure is silent and only
 * shows up as a resume that cannot load, so it is pinned here.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-host-'));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  DATA_DIR: TMP,
}));

const { GROK_HOME_CONTAINER_PATH, ensureGrokSharedDir, grokSharedDir } = await import('./grok.js');
const { getProviderContainerConfig, listProviderContainerConfigNames, providerProvidesAgentSurfaces } = await import(
  './provider-container-registry.js'
);

const ctx = (agentGroupId: string) => ({
  sessionDir: path.join(TMP, 'v2-sessions', agentGroupId, 'sess-1'),
  agentGroupId,
  groupDir: path.join(TMP, 'groups', agentGroupId),
  selectedSkills: [],
  hostEnv: {} as NodeJS.ProcessEnv,
});

beforeAll(() => {
  fs.mkdirSync(path.join(TMP, 'v2-sessions'), { recursive: true });
});
afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('registration', () => {
  it('registers under the provider name the container config resolves', () => {
    expect(listProviderContainerConfigNames()).toContain('grok');
    expect(getProviderContainerConfig('grok')).toBeTypeOf('function');
  });

  it('does not claim to provide agent surfaces — Grok reads CLAUDE.md natively', () => {
    // Claiming this would suppress the host's composed CLAUDE.md and skill
    // links, which are exactly the surfaces Grok already knows how to read.
    expect(providerProvidesAgentSurfaces('grok')).toBe(false);
  });
});

describe('the persistent grok home', () => {
  it('mounts the group dir read-write at the CLI\'s fixed home path', () => {
    const contribution = getProviderContainerConfig('grok')!(ctx('group-A'));
    expect(contribution.mounts).toEqual([
      { hostPath: grokSharedDir('group-A'), containerPath: GROK_HOME_CONTAINER_PATH, readonly: false },
    ]);
    // Read-only would break both halves: the session store and token refresh.
    expect(contribution.mounts?.[0].readonly).toBe(false);
  });

  it('creates the directory, so the first spawn does not race the CLI', () => {
    const dir = grokSharedDir('group-B');
    expect(fs.existsSync(dir)).toBe(false);
    getProviderContainerConfig('grok')!(ctx('group-B'));
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  it('locks the directory to 0700 — it holds a live refresh token', () => {
    const dir = ensureGrokSharedDir('group-C');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('re-tightens an existing directory that was created too permissively', () => {
    const dir = grokSharedDir('group-D');
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    ensureGrokSharedDir('group-D');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('is per agent group, so two groups never share an identity or a session store', () => {
    expect(grokSharedDir('group-A')).not.toBe(grokSharedDir('group-B'));
    expect(grokSharedDir('group-A')).toContain('group-A');
  });

  it('sits beside .claude-shared under the group\'s session dir', () => {
    expect(grokSharedDir('group-A')).toBe(path.join(TMP, 'v2-sessions', 'group-A', '.grok-shared'));
  });

  it('is idempotent across repeated spawns', () => {
    const fn = getProviderContainerConfig('grok')!;
    expect(() => {
      fn(ctx('group-E'));
      fn(ctx('group-E'));
    }).not.toThrow();
  });
});

describe('proxy posture', () => {
  it('contributes NO env — Grok stays on the OneCLI credential path', () => {
    // The inverse of the local-model providers, which NO_PROXY around the
    // gateway. A bypass here would route subscription traffic outside the
    // credential gateway, so its absence is deliberate and pinned.
    const contribution = getProviderContainerConfig('grok')!(ctx('group-F'));
    expect(contribution.env).toBeUndefined();
    expect(JSON.stringify(contribution)).not.toMatch(/NO_PROXY|no_proxy/);
  });
});
