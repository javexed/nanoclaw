import { describe, expect, it, vi, beforeEach } from 'vitest';

const fixture = vi.hoisted(() => ({
  defaultModelId: null as string | null,
  model: null as { kind: string; model_id: string } | null,
  registered: ['claude'] as string[],
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

const { providerForNewAgent } = await import('./models.js');

beforeEach(() => {
  fixture.defaultModelId = null;
  fixture.model = null;
  fixture.registered = ['claude'];
});

describe('providerForNewAgent', () => {
  it('has no opinion when no default model is set', async () => {
    await expect(providerForNewAgent()).resolves.toBeUndefined();
  });

  it('has no opinion for an Anthropic default — that IS the instance default', async () => {
    fixture.defaultModelId = 'm1';
    fixture.model = { kind: 'anthropic', model_id: 'claude-sonnet-4' };
    await expect(providerForNewAgent()).resolves.toBeUndefined();
  });

  it('a local default borns the agent on OpenCode', async () => {
    // The reported bug: wizard order is model → access → first agent, so the
    // agent is created last. Every other path attaches a provider to a group
    // that already exists (PUT /api/models/default, and the boot reconcile),
    // so a group created after both was born on Claude and answered as Sonnet
    // while the UI showed qwen3:8b as the default.
    fixture.defaultModelId = 'm1';
    fixture.model = { kind: 'ollama', model_id: 'qwen3:8b' };
    fixture.registered = ['claude', 'opencode'];
    await expect(providerForNewAgent()).resolves.toBe('opencode');
  });

  it('has no opinion for a local default with no harness installed', async () => {
    // Nothing can run it, so do not pin the group to a provider that is not
    // there — it stays on the default and the wizard's harness row says why.
    fixture.defaultModelId = 'm1';
    fixture.model = { kind: 'ollama', model_id: 'qwen3:8b' };
    fixture.registered = ['claude'];
    await expect(providerForNewAgent()).resolves.toBeUndefined();
  });
});
