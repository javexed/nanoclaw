/**
 * envForModel: an Ollama model's ANTHROPIC_BASE_URL must be the BARE endpoint.
 * The Anthropic SDK appends the full `/v1/messages` path itself; appending `/v1`
 * here makes it hit `<endpoint>/v1/v1/messages` → 404 ("model may not exist").
 */
import { describe, it, expect } from 'vitest';

import { envForModel } from './models.js';

describe('envForModel — ollama base URL', () => {
  it('points ANTHROPIC_BASE_URL at the bare endpoint (no /v1 append)', () => {
    const env = envForModel({
      kind: 'ollama',
      endpoint: 'http://192.168.1.127:11434',
      model_id: 'llama3.2:3b',
    } as never);
    expect(env.ANTHROPIC_BASE_URL).toBe('http://192.168.1.127:11434');
    expect(env.ANTHROPIC_MODEL).toBe('llama3.2:3b');
  });

  it('strips a trailing slash but still does not append /v1', () => {
    const env = envForModel({ kind: 'ollama', endpoint: 'http://host:11434/', model_id: 'm' } as never);
    expect(env.ANTHROPIC_BASE_URL).toBe('http://host:11434');
  });
});

/**
 * Host↔container URL translation. The env block is container-facing: a
 * loopback endpoint (the operator's host-side view) must become the
 * in-container host-gateway alias, or the container calls itself. The
 * reverse mapping lets safeFetch (probe / save-validation, which run on the
 * host) accept an endpoint pasted in container form.
 */
import { containerReachableUrl, hostReachableUrl } from './models.js';

describe('envForModel — container-facing URL rewrite', () => {
  it('rewrites loopback to host.docker.internal for openai-compatible models', () => {
    const env = envForModel({
      kind: 'openai-compatible',
      endpoint: 'http://127.0.0.1:4000/v1',
      model_id: 'gemma4:latest',
    } as never);
    expect(env.OPENAI_BASE_URL).toBe('http://host.docker.internal:4000/v1');
    expect(env.OPENAI_MODEL).toBe('gemma4:latest');
  });

  it('rewrites localhost for ollama models; LAN hosts pass through', () => {
    expect(
      envForModel({ kind: 'ollama', endpoint: 'http://localhost:11434', model_id: 'm' } as never).ANTHROPIC_BASE_URL,
    ).toBe('http://host.docker.internal:11434');
    expect(
      envForModel({ kind: 'ollama', endpoint: 'http://192.168.1.90:11434', model_id: 'm' } as never).ANTHROPIC_BASE_URL,
    ).toBe('http://192.168.1.90:11434');
  });

  it('is anchored — a hostname merely containing localhost is untouched', () => {
    expect(containerReachableUrl('http://localhost.evil.com:4000')).toBe('http://localhost.evil.com:4000');
  });
});

describe('hostReachableUrl', () => {
  it('maps the container-only alias to loopback and leaves everything else', () => {
    expect(hostReachableUrl('http://host.docker.internal:4000/v1')).toBe('http://127.0.0.1:4000/v1');
    expect(hostReachableUrl('http://host.docker.internal.evil.com')).toBe('http://host.docker.internal.evil.com');
    expect(hostReachableUrl('http://192.168.1.90:11434')).toBe('http://192.168.1.90:11434');
  });
});
