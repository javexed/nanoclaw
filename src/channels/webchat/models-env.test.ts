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
