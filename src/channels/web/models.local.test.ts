import { describe, expect, it } from 'vitest';

import { envForModel, openCodeBackendEnv, providerForModelKind } from './models.js';
import type { WebModel } from './db.js';

const at = Date.now();
const anthropic: WebModel = {
  id: 'm1',
  name: 'Opus',
  kind: 'anthropic',
  endpoint: null,
  model_id: 'claude-opus-4-8',
  credential_ref: null,
  created_at: at,
} as WebModel;
const ollama: WebModel = {
  id: 'm2',
  name: 'qwen',
  kind: 'ollama',
  endpoint: 'http://127.0.0.1:11434',
  model_id: 'qwen3:8b',
  credential_ref: null,
  created_at: at,
} as WebModel;
const router: WebModel = {
  id: 'm3',
  name: 'litellm',
  kind: 'openai-compatible',
  endpoint: 'http://localhost:4000/v1/',
  model_id: 'gemma',
  credential_ref: null,
  created_at: at,
} as WebModel;

describe('envForModel — Claude settings only carry an Anthropic model', () => {
  it('sets ANTHROPIC_MODEL for an Anthropic model', () => {
    expect(envForModel(anthropic)).toEqual({ ANTHROPIC_MODEL: 'claude-opus-4-8' });
  });
  it('injects nothing for a local model — it runs on OpenCode, not the Claude provider', () => {
    expect(envForModel(ollama)).toEqual({});
    expect(envForModel(router)).toEqual({});
    expect(envForModel(null)).toEqual({});
  });
});

describe('providerForModelKind', () => {
  it('an Anthropic model stays on the default provider', () => {
    expect(providerForModelKind('anthropic')).toBeNull();
    expect(providerForModelKind(undefined)).toBeNull();
  });
  it('a local model has no harness until OpenCode is installed', () => {
    // Nothing registers the opencode provider in the test process.
    expect(providerForModelKind('ollama')).toBeNull();
    expect(providerForModelKind('openai-compatible')).toBeNull();
  });
});

describe("openCodeBackendEnv — upstream's install-wide contract", () => {
  it('maps an Ollama endpoint to the openai provider at /v1, reachable from the container', () => {
    const b = openCodeBackendEnv(ollama)!;
    expect(b.env).toEqual({
      OPENCODE_PROVIDER: 'openai',
      OPENCODE_BASE_URL: 'http://host.docker.internal:11434/v1',
      OPENCODE_MODEL: 'openai/qwen3:8b',
      // Side tasks (titles, summaries) must target a model this endpoint
      // actually serves — unset, OpenCode asks for its built-in gpt-5.4-nano.
      OPENCODE_SMALL_MODEL: 'openai/qwen3:8b',
    });
    expect(b.proxyHost).toBe('host.docker.internal');
  });
  it('does not double a /v1 the registry endpoint already carries', () => {
    expect(openCodeBackendEnv(router)!.env.OPENCODE_BASE_URL).toBe('http://host.docker.internal:4000/v1');
  });
  it('is null for an Anthropic model or one without an endpoint', () => {
    expect(openCodeBackendEnv(anthropic)).toBeNull();
    expect(openCodeBackendEnv({ ...ollama, endpoint: null })).toBeNull();
  });
});
