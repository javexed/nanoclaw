// node --test coverage for bind-routes.mjs's pure logic.
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseParamB, matchCatalog, scoreModel, chooseBindings, applyDecisions, mergeCatalog } from './bind-routes.mjs';

const CATALOG = {
  max_comfortable_b: 14,
  size_penalty_per_b: 4,
  entries: [
    { pattern: 'ornith', quality: { code: 88, general: 60 } },
    { pattern: 'qwen3-coder', quality: { code: 92 } },
    { pattern: 'qwen3.5', quality: { code: 62, general: 62 } },
    { pattern: 'gemma', quality: { general: 75, reasoning: 72 } },
    { pattern: 'arch-router', quality: {} },
  ],
};

const ROUTES = {
  routes: [
    { name: 'code', description: 'd', model: 'qwen3.5:4b' },
    { name: 'general', description: 'd', model: 'gemma4:latest' },
    { name: 'reasoning', description: 'd', model: 'gemma4:latest', pinned: true },
    { name: 'escalate', description: 'd', escalate: true },
  ],
};

test('parseParamB reads sizes from ids', () => {
  assert.equal(parseParamB('qwen3-coder:30b'), 30);
  assert.equal(parseParamB('ornith-9b'), 9);
  assert.equal(parseParamB('qwen3.5:4b'), 4);
  assert.equal(parseParamB('gemma4:latest'), null);
});

test('size penalty demotes an oversized specialist below a right-sized one', () => {
  // qwen3-coder:30b → 92 − (30−14)×4 = 28; ornith 9b → 88.
  assert.equal(scoreModel('qwen3-coder:30b', 'code', CATALOG), 28);
  assert.equal(scoreModel('ornith:latest', 'code', CATALOG), 88);
});

test('unknown models and capability-less entries never score', () => {
  assert.equal(scoreModel('mystery-model:7b', 'code', CATALOG), null);
  assert.equal(scoreModel('hf.co/katanemo/Arch-Router-1.5B.gguf:Q4_K_M', 'code', CATALOG), null);
});

test('chooseBindings rebinds code to ornith, respects pins and escalate', () => {
  const roster = ['qwen3.5:4b', 'gemma4:latest', 'ornith:latest', 'qwen3-coder:30b', 'arch-router-1.5b'];
  const { decisions, unknown } = chooseBindings(structuredClone(ROUTES), roster, CATALOG);
  const by = Object.fromEntries(decisions.map((d) => [d.route, d]));
  assert.equal(by.code.chosen, 'ornith:latest');
  assert.equal(by.code.changed, true);
  assert.equal(by.general.chosen, 'gemma4:latest');
  assert.equal(by.general.changed, false);
  assert.equal(by.reasoning.pinned, true);
  assert.equal(by.escalate.pinned, true);
  assert.deepEqual(unknown, []);
});

test('a route with no scored candidate keeps its current binding', () => {
  const routes = { routes: [{ name: 'vision', description: 'd', model: 'llava:7b' }] };
  const { decisions } = chooseBindings(routes, ['gemma4:latest'], CATALOG);
  assert.equal(decisions[0].chosen, 'llava:7b');
  assert.equal(decisions[0].changed, false);
});

test('applyDecisions writes only unpinned changes', () => {
  const cfg = structuredClone(ROUTES);
  const { decisions } = chooseBindings(structuredClone(ROUTES), ['ornith:latest', 'gemma4:latest'], CATALOG);
  applyDecisions(cfg, decisions);
  assert.equal(cfg.routes[0].model, 'ornith:latest'); // code rebound
  assert.equal(cfg.routes[2].model, 'gemma4:latest'); // pinned untouched
});

test('mergeCatalog puts local entries first and lets knobs override', () => {
  const merged = mergeCatalog(CATALOG, {
    max_comfortable_b: 30,
    entries: [{ pattern: 'qwen3-coder', quality: { code: 99 } }],
  });
  // Local entry wins the match, and the raised comfort ceiling kills the penalty.
  assert.equal(scoreModel('qwen3-coder:30b', 'code', merged), 99);
});

test('unknown roster models are reported', () => {
  const { unknown } = chooseBindings(structuredClone(ROUTES), ['brand-new-thing:8b'], CATALOG);
  assert.deepEqual(unknown, ['brand-new-thing:8b']);
});
