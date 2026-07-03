import test from 'node:test';
import assert from 'node:assert/strict';

import { rosterToModelRows } from './register-models.mjs';

const EP = 'http://host.docker.internal:4000/v1';

test('maps each roster id to an openai-compatible row with the container-facing endpoint', () => {
  const rows = rosterToModelRows(['llama3.2:3b', 'qwen3-coder:30b'], EP, [], 123);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.kind, 'openai-compatible');
    assert.equal(r.endpoint, EP);
    assert.equal(r.created_at, 123);
    assert.equal(r.name, r.model_id);
    assert.ok(r.id.length > 10);
    assert.equal(r.credential_ref, null);
  }
});

test('skips names already registered — case-insensitively (the UI dedupe rule)', () => {
  const rows = rosterToModelRows(['llama3.2:3b', 'gemma4:latest'], EP, ['LLAMA3.2:3B'], 0);
  assert.deepEqual(
    rows.map((r) => r.model_id),
    ['gemma4:latest'],
  );
});

test('dedupes within one roster (same model surfaced twice never double-registers)', () => {
  const rows = rosterToModelRows(['a', 'a', 'b'], EP, [], 0);
  assert.deepEqual(
    rows.map((r) => r.model_id),
    ['a', 'b'],
  );
});

test('empty roster → no rows', () => {
  assert.deepEqual(rosterToModelRows([], EP, ['x'], 0), []);
});
