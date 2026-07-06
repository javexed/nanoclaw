#!/usr/bin/env node
/**
 * bind-routes.mjs — bind capability routes to the best available roster
 * model, automatically (llm-router.md §16b "benchmark-seeded capability
 * table informs the route→model bindings").
 *
 * Reads the LiteLLM roster (/v1/models) and the capability catalog
 * (capabilities.json, merged under the operator's optional
 * data/litellm/routing/capabilities.local.json), scores every roster model
 * per route, and rewrites the UNPINNED bindings in routes.json:
 *
 *   score(model, route) = catalog quality − size penalty
 *   size penalty = max(0, paramB − max_comfortable_b) × size_penalty_per_b
 *
 * The size penalty encodes "a 30B on modest hardware loses to a good 9B"
 * without hardcoding hosts (paramB parsed from the model id: ':30b', '-9b',
 * …). Operators pin a route with `"pinned": true` in routes.json — the
 * binder never touches those, or the escalate route (no local binding by
 * design), or route DESCRIPTIONS (the classifier's whole game).
 *
 * Dry-run by default (prints the decision table); --apply writes routes.json
 * atomically. Wired into the nightly recalibration timer and the webchat
 * "Refresh roster" chain, so a newly pulled model joins routing on its own.
 *
 *   node bind-routes.mjs [--apply] [--routing-dir data/litellm/routing]
 *                        [--roster a,b,c]  (test override, skips the fetch)
 */
import fs from 'node:fs';
import path from 'node:path';

// ── Pure logic (exported for node --test) ─────────────────────────────────

/** Parameter count in billions from a model id; null when unparseable. */
export function parseParamB(modelId) {
  const m = modelId.toLowerCase().match(/(\d+(?:\.\d+)?)b\b/);
  return m ? parseFloat(m[1]) : null;
}

/** First matching catalog entry wins; local entries are matched before stock. */
export function matchCatalog(modelId, entries) {
  const id = modelId.toLowerCase();
  return entries.find((e) => id.includes(e.pattern.toLowerCase())) ?? null;
}

export function scoreModel(modelId, route, catalog) {
  const entry = matchCatalog(modelId, catalog.entries);
  if (!entry) return null; // unknown model — never auto-bound
  const quality = entry.quality?.[route];
  if (quality == null) return null; // no claim for this capability
  const paramB = parseParamB(modelId);
  const maxB = catalog.max_comfortable_b ?? 14;
  const perB = catalog.size_penalty_per_b ?? 4;
  const penalty = paramB != null && paramB > maxB ? (paramB - maxB) * perB : 0;
  return quality - penalty;
}

/**
 * Decide bindings for every unpinned, non-escalate route. Returns
 * { decisions: [{route, current, chosen, score, changed, pinned}], unknown: [...] }.
 */
export function chooseBindings(routesCfg, roster, catalog) {
  const decisions = [];
  const unknown = roster.filter((m) => !matchCatalog(m, catalog.entries));
  for (const r of routesCfg.routes) {
    if (r.escalate) {
      decisions.push({ route: r.name, current: null, chosen: null, score: null, changed: false, pinned: true });
      continue;
    }
    if (r.pinned) {
      decisions.push({ route: r.name, current: r.model, chosen: r.model, score: null, changed: false, pinned: true });
      continue;
    }
    let best = null;
    let bestScore = -Infinity;
    for (const m of roster) {
      const s = scoreModel(m, r.name, catalog);
      if (s != null && s > bestScore) {
        best = m;
        bestScore = s;
      }
    }
    // No scored candidate → keep the current binding (never leave a route dangling).
    const chosen = best ?? r.model;
    decisions.push({
      route: r.name,
      current: r.model,
      chosen,
      score: best ? Math.round(bestScore) : null,
      changed: chosen !== r.model,
      pinned: false,
    });
  }
  return { decisions, unknown };
}

export function applyDecisions(routesCfg, decisions) {
  const byName = new Map(decisions.map((d) => [d.route, d]));
  for (const r of routesCfg.routes) {
    const d = byName.get(r.name);
    if (d && !d.pinned && d.chosen && d.chosen !== r.model) r.model = d.chosen;
  }
  return routesCfg;
}

export function mergeCatalog(stock, local) {
  if (!local) return stock;
  return {
    ...stock,
    ...('max_comfortable_b' in local ? { max_comfortable_b: local.max_comfortable_b } : {}),
    ...('size_penalty_per_b' in local ? { size_penalty_per_b: local.size_penalty_per_b } : {}),
    entries: [...(local.entries ?? []), ...stock.entries], // local matched first
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────

async function fetchRoster() {
  // LiteLLM's default port from /add-litellm — mirrored in ollama-manage.ts and
  // the app.js roster-endpoint regex; change all three together if it moves.
  const res = await fetch('http://127.0.0.1:4000/v1/models', { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`router /v1/models returned ${res.status}`);
  const body = await res.json();
  return (body.data ?? []).map((m) => m.id).filter((x) => typeof x === 'string');
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(n);
  const opt = (n, d) => {
    const i = argv.indexOf(n);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
  };
  const routingDir = opt('--routing-dir', 'data/litellm/routing');
  const routesPath = path.join(routingDir, 'routes.json');
  const here = path.dirname(new URL(import.meta.url).pathname);

  const stock = JSON.parse(fs.readFileSync(path.join(here, 'capabilities.json'), 'utf8'));
  const localPath = path.join(routingDir, 'capabilities.local.json');
  const local = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : null;
  const catalog = mergeCatalog(stock, local);

  const routesCfg = JSON.parse(fs.readFileSync(routesPath, 'utf8'));
  const rosterArg = opt('--roster', null);
  const roster = rosterArg ? rosterArg.split(',').map((s) => s.trim()) : await fetchRoster();

  const { decisions, unknown } = chooseBindings(routesCfg, roster, catalog);
  for (const d of decisions) {
    const mark = d.pinned ? 'pinned' : d.changed ? `→ ${d.chosen} (score ${d.score})` : `= ${d.chosen ?? '(none)'}`;
    console.log(`${d.route.padEnd(10)} ${d.pinned ? '' : (d.current ?? '(none)') + ' '}${mark}`);
  }
  if (unknown.length > 0) {
    console.log(`unknown to catalog (never auto-bound): ${unknown.join(', ')} — add to capabilities.local.json`);
  }
  const changes = decisions.filter((d) => d.changed);
  if (changes.length === 0) {
    console.log('no binding changes.');
    return;
  }
  if (!flag('--apply')) {
    console.log(`${changes.length} change(s) NOT applied (dry run — pass --apply).`);
    return;
  }
  applyDecisions(routesCfg, decisions);
  const tmp = routesPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(routesCfg, null, 2) + '\n');
  fs.renameSync(tmp, routesPath);
  console.log(`applied ${changes.length} binding change(s) to ${routesPath}.`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((err) => {
    console.error('[bind-routes]', err.message);
    process.exit(1);
  });
}
