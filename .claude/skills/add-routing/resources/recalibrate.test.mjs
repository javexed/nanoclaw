// node --test coverage for recalibrate.mjs's pure logic.
//   node --test .claude/skills/add-routing/resources/recalibrate.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLog,
  inWindow,
  percentile,
  computeMetrics,
  recommendTimeout,
  renderReport,
  splitForRotation,
} from './recalibrate.mjs';

const NOW = 1_783_200_000_000;
const day = 86_400_000;
const line = (o) => JSON.stringify(o);

test('parseLog skips corrupt lines and keeps valid ones', () => {
  const text = [line({ ts: 1, route: 'code', ms: 900 }), '{torn', '', line({ ts: 2, route: 'general', ms: 700 })].join(
    '\n',
  );
  assert.equal(parseLog(text).length, 2);
});

test('inWindow filters by ts', () => {
  const entries = [{ ts: NOW - 8 * day }, { ts: NOW - 2 * day }, { ts: NOW }];
  assert.equal(inWindow(entries, NOW, 7).length, 2);
});

test('percentile on small samples', () => {
  assert.equal(percentile([], 95), null);
  assert.equal(percentile([100], 95), 100);
  assert.equal(percentile([100, 200, 300, 400], 50), 200);
});

test('computeMetrics: modes, routes, errors, escalations, latency', () => {
  const entries = [
    { ts: NOW, mode: 'live', route: 'code', ms: 900, final_model: 'qwen3.5:4b' },
    { ts: NOW, mode: 'live', route: 'escalate', ms: 1100, final_model: '__escalate__' },
    { ts: NOW, mode: 'live', route: '__error__', ms: 5020, error: 'ReadTimeout: ' },
    { ts: NOW, route: 'other', ms: 800 }, // legacy line, no mode → shadow
  ];
  const m = computeMetrics(entries);
  assert.equal(m.total, 4);
  assert.equal(m.byMode.live, 3);
  assert.equal(m.byMode.shadow, 1);
  assert.equal(m.errors, 1);
  assert.equal(m.timeouts, 1);
  assert.equal(m.escalations, 1);
  assert.equal(m.other, 1);
  assert.equal(m.liveTotal, 3);
  assert.equal(m.latency.samples, 3); // the __error__ ms is excluded
  assert.equal(m.latency.max, 1100);
});

test('recommendTimeout: needs 5+ samples, respects 20% deadband, clamps and rounds', () => {
  const base = { latency: { samples: 4, p95: 900 } };
  assert.equal(recommendTimeout(base, 5000), null); // too few samples

  const m = { latency: { samples: 20, p95: 900 } }; // ×1.5 = 1350 → clamp 2000
  const rec = recommendTimeout(m, 5000);
  assert.equal(rec.recommended, 2000);

  // within 20% of current → no recommendation
  assert.equal(recommendTimeout({ latency: { samples: 20, p95: 3000 } }, 5000), null); // 4500 vs 5000 = 10%

  // slow classifier → clamp at 15000
  assert.equal(recommendTimeout({ latency: { samples: 20, p95: 30000 } }, 5000).recommended, 15000);

  // rounding up to 500
  assert.equal(recommendTimeout({ latency: { samples: 20, p95: 3400 } }, 8000).recommended, 5500); // 5100 → 5500
});

test('renderReport flags high other/error/escalation rates', () => {
  const metrics = computeMetrics([
    { ts: NOW, mode: 'live', route: 'escalate', ms: 1000, final_model: '__escalate__' },
    { ts: NOW, mode: 'live', route: 'other', ms: 900 },
    { ts: NOW, mode: 'live', route: '__error__', ms: 5000, error: 'ReadTimeout' },
  ]);
  const report = renderReport({ metrics, rec: null, days: 7, currentTimeout: 8000, generatedAt: '2026-07-04T00:00:00Z' });
  assert.match(report, /error rate/);
  assert.match(report, /`other` rate/);
  assert.match(report, /escalation rate/);
});

test('renderReport with empty window says so', () => {
  const report = renderReport({
    metrics: computeMetrics([]),
    rec: null,
    days: 7,
    currentTimeout: null,
    generatedAt: '2026-07-04T00:00:00Z',
  });
  assert.match(report, /no traffic in the window/);
});

test('splitForRotation partitions on the cutoff', () => {
  const entries = [{ ts: NOW - 40 * day }, { ts: NOW - 10 * day }, { ts: NOW }];
  const { keep, archive } = splitForRotation(entries, NOW, 30);
  assert.equal(keep.length, 2);
  assert.equal(archive.length, 1);
});
