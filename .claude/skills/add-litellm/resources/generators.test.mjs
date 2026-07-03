/**
 * generators.test.mjs — fixture-driven tests for gen-config.mjs.
 * Runs with plain `node --test` (no vitest — this skill has no core
 * integration points; see docs/skill-guidelines.md). No network: fixtures
 * stand in for the hosts' roster endpoints (Ollama /api/tags shape and
 * OpenAI-compatible /v1/models shape).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate as genConfig } from './gen-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(HERE, 'fixtures/rosters.json'), 'utf8'));
const OLLAMA_HOSTS = ['http://localhost:11434', 'http://10.0.0.5:11434'];
const ALL_HOSTS = [...OLLAMA_HOSTS, 'http://10.0.0.7:8000'];

test('model_list covers all hosts, localhost rewritten for the container', async () => {
  const yaml = await genConfig({ hosts: OLLAMA_HOSTS, fixtures });
  // (values containing ':' are YAML-quoted by the generator — regexes allow it)
  assert.match(yaml, /api_base: "?http:\/\/host\.docker\.internal:11434"?/);
  assert.match(yaml, /api_base: "?http:\/\/10\.0\.0\.5:11434"?/);
  // ollama_chat prefix (chat + tool-call support)
  assert.match(yaml, /model: "?ollama_chat\/qwen2\.5-coder:14b"?/);
});

test('same tag on two hosts = two deployments under one model_name (load-balanced)', async () => {
  const yaml = await genConfig({ hosts: OLLAMA_HOSTS, fixtures });
  const dupes = yaml.match(/model_name: "?qwen2\.5-coder:14b"?/g);
  assert.equal(dupes.length, 2);
});

test('OpenAI-compatible host: openai/ prefix + placeholder api_key, no ollama coupling', async () => {
  const yaml = await genConfig({ hosts: ['http://10.0.0.7:8000'], fixtures });
  assert.match(yaml, /model: "?openai\/mistral-7b-instruct"?/);
  assert.match(yaml, /api_base: "?http:\/\/10\.0\.0\.7:8000"?/);
  // keyless server still needs LiteLLM's required api_key field — placeholder only
  assert.match(yaml, /api_key: keyless/);
  assert.doesNotMatch(yaml, /ollama_chat\//);
});

test('cross-kind load balancing: same model on ollama + openai hosts shares one model_name', async () => {
  const yaml = await genConfig({ hosts: ALL_HOSTS, fixtures });
  const dupes = yaml.match(/model_name: "?qwen2\.5-coder:14b"?/g);
  assert.equal(dupes.length, 3); // 2 ollama deployments + 1 openai-compat
  assert.match(yaml, /model: "?ollama_chat\/qwen2\.5-coder:14b"?/);
  assert.match(yaml, /model: "?openai\/qwen2\.5-coder:14b"?/);
});

test('keyless + agentic obligations: no master_key setting, generous timeouts', async () => {
  const yaml = await genConfig({ hosts: ALL_HOSTS, fixtures });
  // settings, not the explanatory comment that names them
  assert.doesNotMatch(yaml, /^\s*master_key\s*:/m);
  assert.doesNotMatch(yaml, /^\s*database_url\s*:/im);
  assert.match(yaml, /request_timeout: 600/);
  assert.match(yaml, /num_retries: 2/);
});

test('no classifier coupling in the minimal skill (dependent layers own that)', async () => {
  const yaml = await genConfig({ hosts: ALL_HOSTS, fixtures });
  assert.doesNotMatch(yaml, /callbacks/);
  assert.doesNotMatch(yaml, /fallbacks/);
});

test('empty roster is a hard error', async () => {
  await assert.rejects(
    () => genConfig({ hosts: ['http://localhost:11434'], fixtures: { 'http://localhost:11434': { models: [] } } }),
    /no models discovered/,
  );
});

test('unrecognizable roster shape is a hard error naming the host', async () => {
  await assert.rejects(
    () => genConfig({ hosts: ['http://bad:1'], fixtures: { 'http://bad:1': { nope: true } } }),
    /neither Ollama nor OpenAI/,
  );
});
