#!/usr/bin/env node
/**
 * recalibrate.mjs — nightly threshold recalibration (llm-router.md §16e tier-1).
 *
 * Reads the routing decision log (routing-shadow.jsonl), computes the health
 * metrics that parameterize the live router, and:
 *   - always: writes a dated markdown report next to the log + prints it
 *   - --apply: adjusts routes.json `live.timeout_ms` from observed latency
 *     (p95 of successful classifies × 1.5, clamped to [2000, 15000], rounded
 *     to 500ms) when it drifts >20% from the current value. The ONLY knob
 *     auto-tuned — everything else is a recommendation for the operator,
 *     because route descriptions and bindings are judgment calls (SKILL.md:
 *     "the whole game is route descriptions").
 *   - --rotate: moves entries older than --keep-days (default 30) to
 *     routing-shadow.archive.jsonl so the hot log stays small.
 *
 * Zero dependencies; safe to run any time (idempotent, atomic writes).
 *
 *   node recalibrate.mjs [--days 7] [--apply] [--rotate] [--keep-days 30]
 *                        [--routing-dir data/litellm/routing]
 */
import fs from 'node:fs';
import path from 'node:path';

// ── Pure logic (exported for node --test) ─────────────────────────────────

export function parseLog(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (typeof e.ts === 'number') entries.push(e);
    } catch {
      /* torn write or corrupt line — skip */
    }
  }
  return entries;
}

export function inWindow(entries, nowMs, days) {
  const since = nowMs - days * 86_400_000;
  return entries.filter((e) => e.ts >= since);
}

export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function computeMetrics(entries) {
  const m = {
    total: entries.length,
    byMode: {},
    byRoute: {},
    errors: 0,
    timeouts: 0,
    escalations: 0,
    other: 0,
    liveTotal: 0,
    latency: { p50: null, p95: null, max: null, samples: 0 },
  };
  const okLatencies = [];
  for (const e of entries) {
    const mode = e.mode || 'shadow'; // pre-Phase-2 lines lack the field
    m.byMode[mode] = (m.byMode[mode] || 0) + 1;
    if (mode === 'live') m.liveTotal += 1;
    const route = e.route || '?';
    m.byRoute[route] = (m.byRoute[route] || 0) + 1;
    if (route === '__error__') {
      m.errors += 1;
      if (/ReadTimeout|timed? ?out/i.test(e.error || '')) m.timeouts += 1;
    } else {
      if (typeof e.ms === 'number') okLatencies.push(e.ms);
      if (route === 'other') m.other += 1;
      if (e.final_model === '__escalate__' || e.bound_model === '__escalate__') m.escalations += 1;
    }
  }
  okLatencies.sort((a, b) => a - b);
  m.latency = {
    p50: percentile(okLatencies, 50),
    p95: percentile(okLatencies, 95),
    max: okLatencies.at(-1) ?? null,
    samples: okLatencies.length,
  };
  return m;
}

/**
 * Timeout recommendation: p95 of successful classifies × 1.5, clamped to
 * [2000, 15000], rounded up to the next 500ms. Null when there's no basis
 * (fewer than 5 samples) or the current value is already within 20%.
 */
export function recommendTimeout(metrics, currentMs) {
  if (metrics.latency.samples < 5 || metrics.latency.p95 == null) return null;
  const raw = metrics.latency.p95 * 1.5;
  const clamped = Math.min(15_000, Math.max(2_000, raw));
  const recommended = Math.ceil(clamped / 500) * 500;
  if (currentMs && Math.abs(recommended - currentMs) / currentMs <= 0.2) return null;
  return {
    recommended,
    reason: `p95 classify latency ${metrics.latency.p95}ms over ${metrics.latency.samples} samples → ×1.5 → ${recommended}ms (current ${currentMs ?? 'unset'}ms)`,
  };
}

export function renderReport({ metrics, rec, days, currentTimeout, generatedAt }) {
  const pct = (n, d) => (d > 0 ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');
  const routes = Object.entries(metrics.byRoute)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `| ${r} | ${n} | ${pct(n, metrics.total)} |`)
    .join('\n');
  const lines = [
    `# Routing recalibration — ${generatedAt}`,
    '',
    `Window: last ${days} day(s) · ${metrics.total} classified request(s) (${metrics.byMode.live || 0} live, ${metrics.byMode.shadow || 0} shadow)`,
    '',
    '| route | count | share |',
    '|---|---|---|',
    routes || '| (none) | 0 | n/a |',
    '',
    `- classifier errors: ${metrics.errors} (${pct(metrics.errors, metrics.total)}) — of which timeouts: ${metrics.timeouts}`,
    `- \`other\` (no route matched): ${metrics.other} (${pct(metrics.other, metrics.total)})`,
    `- escalations: ${metrics.escalations} (${pct(metrics.escalations, metrics.liveTotal)} of live traffic)`,
    `- classify latency (successful): p50 ${metrics.latency.p50 ?? 'n/a'}ms · p95 ${metrics.latency.p95 ?? 'n/a'}ms · max ${metrics.latency.max ?? 'n/a'}ms (${metrics.latency.samples} samples)`,
    `- live.timeout_ms: ${currentTimeout ?? 'unset'}${rec ? ` → **recommend ${rec.recommended}** (${rec.reason})` : ' — no change recommended'}`,
    '',
    '## Operator signals (not auto-tuned)',
    '',
  ];
  if (metrics.total === 0) {
    lines.push('- no traffic in the window — nothing to conclude.');
  } else {
    if (metrics.errors / metrics.total > 0.2)
      lines.push(
        `- ⚠ error rate ${pct(metrics.errors, metrics.total)} — classifier host availability problem (asleep? evicted?). Consider pinning Arch-Router harder or moving it.`,
      );
    if (metrics.other / metrics.total > 0.15)
      lines.push(
        `- ⚠ \`other\` rate ${pct(metrics.other, metrics.total)} — route descriptions don't cover real traffic; add or reword routes (SKILL.md "Tuning").`,
      );
    if (metrics.liveTotal > 0 && metrics.escalations / metrics.liveTotal > 0.3)
      lines.push(
        `- ⚠ escalation rate ${pct(metrics.escalations, metrics.liveTotal)} of live traffic — the escalate route may be over-matching (fallback quota burn); narrow its description.`,
      );
    if (lines.at(-1) === '') lines.push('- all rates within normal bands.');
  }
  return lines.join('\n') + '\n';
}

export function splitForRotation(entries, nowMs, keepDays) {
  const cutoff = nowMs - keepDays * 86_400_000;
  return {
    keep: entries.filter((e) => e.ts >= cutoff),
    archive: entries.filter((e) => e.ts < cutoff),
  };
}

/** Named routers {name:{routes,default_route,timeout_ms}}; normalizes the
 *  pre-multi-router format. KEEP-IN-SYNC with router_hook.py / bind-routes.mjs. */
export function routers(cfg) {
  if (cfg.routers && typeof cfg.routers === 'object') return cfg.routers;
  const name = cfg.live?.model_name ?? 'auto';
  return { [name]: { routes: cfg.routes ?? [], default_route: cfg.default_route, timeout_ms: cfg.live?.timeout_ms ?? 5000 } };
}

// ── CLI ────────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes(name);
  const opt = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  const days = Number(opt('--days', '7'));
  const keepDays = Number(opt('--keep-days', '30'));
  const routingDir = opt('--routing-dir', 'data/litellm/routing');
  const logPath = path.join(routingDir, 'routing-shadow.jsonl');
  const routesPath = path.join(routingDir, 'routes.json');
  const now = Date.now();

  const text = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const all = parseLog(text);
  const windowed = inWindow(all, now, days);
  const metrics = computeMetrics(windowed);

  let routes = null;
  let currentTimeout = null;
  if (fs.existsSync(routesPath)) {
    routes = JSON.parse(fs.readFileSync(routesPath, 'utf8'));
    currentTimeout = routes.live?.timeout_ms ?? null;
  }
  const rec = recommendTimeout(metrics, currentTimeout);

  const generatedAt = new Date(now).toISOString();
  const report = renderReport({ metrics, rec, days, currentTimeout, generatedAt });
  const reportPath = path.join(routingDir, `recalibration-${generatedAt.slice(0, 10)}.md`);
  fs.writeFileSync(reportPath, report);
  process.stdout.write(report);
  console.error(`[recalibrate] report → ${reportPath}`);

  // Tune each router's classify timeout from ITS OWN observed latency. New
  // format writes router.timeout_ms; the old single-router format writes
  // live.timeout_ms (the normalized router aliases it). A router with no
  // traffic in the window is left untouched.
  if (flag('--apply') && routes) {
    const rmap = routers(routes);
    const applied = [];
    for (const [name, router] of Object.entries(rmap)) {
      const rEntries = windowed.filter((e) => (e.router ?? name) === name);
      const cur = router.timeout_ms ?? routes.live?.timeout_ms ?? null;
      const r = recommendTimeout(computeMetrics(rEntries), cur);
      if (!r) continue;
      if (routes.routers) router.timeout_ms = r.recommended;
      else if (routes.live) routes.live.timeout_ms = r.recommended;
      applied.push(`${name}=${r.recommended} (was ${cur ?? 'unset'})`);
    }
    if (applied.length > 0) {
      const tmp = routesPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(routes, null, 2) + '\n');
      fs.renameSync(tmp, routesPath);
      console.error(`[recalibrate] applied timeout(s): ${applied.join(', ')}`);
    }
  }

  if (flag('--rotate') && all.length > 0) {
    const { keep, archive } = splitForRotation(all, now, keepDays);
    if (archive.length > 0) {
      const archivePath = path.join(routingDir, 'routing-shadow.archive.jsonl');
      fs.appendFileSync(archivePath, archive.map((e) => JSON.stringify(e)).join('\n') + '\n');
      const tmp = logPath + '.tmp';
      fs.writeFileSync(tmp, keep.length > 0 ? keep.map((e) => JSON.stringify(e)).join('\n') + '\n' : '');
      fs.renameSync(tmp, logPath);
      console.error(`[recalibrate] rotated ${archive.length} entrie(s) older than ${keepDays}d → ${archivePath}`);
    }
  }
}

// Only run the CLI when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main();
}
