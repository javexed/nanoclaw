import { describe, expect, it, vi, beforeEach } from 'vitest';

const fixture = vi.hoisted(() => ({
  defaultModelId: null as string | null,
  model: null as { kind: string; model_id: string } | null,
  registered: ['claude'] as string[],
  envFile: {} as Record<string, string>,
  written: [] as Array<[string, string]>,
}));

vi.mock('./db.js', () => ({
  getDefaultModelId: async () => fixture.defaultModelId,
  getWebModel: async () => fixture.model,
  getAssignedModelForAgent: async () => null,
  getEffectiveModelForAgent: async () => fixture.model,
}));
vi.mock('../../providers/provider-container-registry.js', () => ({
  listProviderContainerConfigNames: () => fixture.registered,
}));
vi.mock('./env-write.js', () => ({
  upsertEnv: (_root: string, k: string, v: string) => fixture.written.push([k, v]),
}));
// readEnvFile lives in src/env.ts, not the web module's env-write.ts.
vi.mock('../../env.js', () => ({ readEnvFile: () => fixture.envFile }));

const { syncInstanceDefaultProvider } = await import('./models.js');

beforeEach(() => {
  fixture.defaultModelId = null;
  fixture.model = null;
  fixture.registered = ['claude'];
  fixture.envFile = {};
  fixture.written = [];
});

describe('syncInstanceDefaultProvider', () => {
  const localDefault = () => {
    fixture.defaultModelId = 'm1';
    fixture.model = { kind: 'ollama', model_id: 'qwen3:8b' };
    fixture.registered = ['claude', 'opencode'];
  };

  it('stamps opencode when a local model is the default and the harness exists', async () => {
    // The gap this closes: ncl-created and channel-approved groups read
    // DEFAULT_AGENT_PROVIDER at creation, so without this they are born on
    // Claude and only corrected by the next boot reconcile.
    localDefault();
    await expect(syncInstanceDefaultProvider('/srv')).resolves.toBe('opencode');
    expect(fixture.written).toEqual([['DEFAULT_AGENT_PROVIDER', 'opencode']]);
  });

  it('puts it back to claude when the default returns to Claude', async () => {
    fixture.envFile = { DEFAULT_AGENT_PROVIDER: 'opencode' };
    await expect(syncInstanceDefaultProvider('/srv')).resolves.toBe('claude');
    expect(fixture.written).toEqual([['DEFAULT_AGENT_PROVIDER', 'claude']]);
  });

  it('writes nothing when it already says what it should', async () => {
    localDefault();
    fixture.envFile = { DEFAULT_AGENT_PROVIDER: 'opencode' };
    await expect(syncInstanceDefaultProvider('/srv')).resolves.toBeNull();
    expect(fixture.written).toEqual([]);
  });

  it('leaves a local default alone when no harness is installed', async () => {
    // Nothing can run it; pinning new groups to a provider that is not there
    // would be worse than leaving them on the default.
    localDefault();
    fixture.registered = ['claude'];
    await expect(syncInstanceDefaultProvider('/srv')).resolves.toBe('claude');
  });

  it('never clobbers a provider an operator chose by hand', async () => {
    localDefault();
    fixture.envFile = { DEFAULT_AGENT_PROVIDER: 'codex' };
    await expect(syncInstanceDefaultProvider('/srv')).resolves.toBeNull();
    expect(fixture.written).toEqual([]);
  });
});
