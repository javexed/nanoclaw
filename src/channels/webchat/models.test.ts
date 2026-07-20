/**
 * classifierParamsForModel — turns a roster model into container-reachable
 * learning-classifier params ({url, model}), or null when the model can't serve
 * one. Shared by the Settings override and the auto-default-to-agent's-model
 * resolver, so the runner's OpenAI-format /v1/chat/completions call is right.
 */
import { describe, it, expect } from 'vitest';
import { classifierParamsForModel } from './models.js';
import type { WebchatModel } from './db.js';

function model(p: Partial<WebchatModel>): WebchatModel {
  return { id: 'm', name: 'm', kind: 'ollama', endpoint: null, model_id: 'x', credential_ref: null, created_at: 0, ...p };
}

describe('classifierParamsForModel', () => {
  it('remote Ollama → its own endpoint + /v1/chat/completions', () => {
    expect(classifierParamsForModel(model({ kind: 'ollama', endpoint: 'http://192.0.2.90:11434', model_id: 'llama3.2:3b' }))).toEqual({
      url: 'http://192.0.2.90:11434/v1/chat/completions',
      model: 'llama3.2:3b',
    });
  });

  it('local loopback is rewritten to the docker host-gateway (a container can’t reach 127.0.0.1)', () => {
    expect(classifierParamsForModel(model({ kind: 'openai-compatible', endpoint: 'http://127.0.0.1:4000/v1', model_id: 'auto' }))).toEqual({
      url: 'http://host.docker.internal:4000/v1/chat/completions',
      model: 'auto',
    });
    expect(classifierParamsForModel(model({ kind: 'ollama', endpoint: 'http://localhost:11434', model_id: 'q' }))?.url).toBe(
      'http://host.docker.internal:11434/v1/chat/completions',
    );
  });

  it('anthropic / endpoint-less / null → null (no local endpoint to call → heuristic)', () => {
    expect(classifierParamsForModel(model({ kind: 'anthropic', endpoint: null, model_id: 'claude-opus-4-8' }))).toBeNull();
    expect(classifierParamsForModel(model({ kind: 'ollama', endpoint: null }))).toBeNull();
    expect(classifierParamsForModel(null)).toBeNull();
  });
});
