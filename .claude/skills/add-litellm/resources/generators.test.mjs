/**
 * generators.test.mjs — fixture-driven tests for gen-config.mjs.
 * Runs with plain `node --test` (no vitest — this skill has no core
 * integration points; see docs/skill-guidelines.md). No network: fixtures
 * stand in for Ollama /api/tags.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate as genConfig } from './gen-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(HERE, 'fixtures/ollama-tags.json'), 'utf8'));
const HOSTS = ['http://localhost:11434', 'http://10.0.0.5:11434'];

test('model_list covers all hosts, localhost rewritten for the container', async () => {
  const yaml = await genConfig({ hosts: HOSTS, fixtures });
  // (values containing ':' are YAML-quoted by the generator — regexes allow it)
  assert.match(yaml, /api_base: "?http:\/\/host\.docker\.internal:11434"?/);
  assert.match(yaml, /api_base: "?http:\/\/10\.0\.0\.5:11434"?/);
  // ollama_chat prefix (chat + tool-call support)
  assert.match(yaml, /model: "?ollama_chat\/qwen2\.5-coder:14b"?/);
});

test('same tag on two hosts = two deployments under one model_name (load-balanced)', async () => {
  const yaml = await genConfig({ hosts: HOSTS, fixtures });
  const dupes = yaml.match(/model_name: "?qwen2\.5-coder:14b"?/g);
  assert.equal(dupes.length, 2);
});

test('keyless + agentic obligations: no master_key setting, generous timeouts', async () => {
  const yaml = await genConfig({ hosts: HOSTS, fixtures });
  // settings, not the explanatory comment that names them
  assert.doesNotMatch(yaml, /^\s*master_key\s*:/m);
  assert.doesNotMatch(yaml, /^\s*database_url\s*:/im);
  assert.match(yaml, /request_timeout: 600/);
  assert.match(yaml, /num_retries: 2/);
});

test('no classifier coupling in the minimal skill (dependent layers own that)', async () => {
  const yaml = await genConfig({ hosts: HOSTS, fixtures });
  assert.doesNotMatch(yaml, /callbacks/);
  assert.doesNotMatch(yaml, /fallbacks/);
});

test('empty roster is a hard error', async () => {
  await assert.rejects(
    () => genConfig({ hosts: ['http://localhost:11434'], fixtures: { 'http://localhost:11434': { models: [] } } }),
    /no models discovered/,
  );
});
