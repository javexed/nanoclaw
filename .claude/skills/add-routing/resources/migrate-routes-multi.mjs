#!/usr/bin/env node
/**
 * migrate-routes-multi.mjs — convert a single-router routes.json to the
 * multi-router shape, in place. Opt-in: run it once to move from one global
 * `auto` router to the `routers: { name: {...} }` map, after which you can add
 * more profiles (each an entry keyed by the virtual model name agents assign).
 *
 * Idempotent: a config that already has `routers` is left untouched. Atomic.
 * The hook / binder / recalibrate all read BOTH shapes, so this migration is
 * never required — it just gives you the multi-router base to extend.
 *
 *   node migrate-routes-multi.mjs [--routing-dir data/litellm/routing] [--dry-run]
 *
 * Old shape:                          New shape:
 *   { classifier, default_route,        { classifier,
 *     live:{enabled,model_name,           live:{enabled},
 *          timeout_ms},                   routers:{ "<model_name>": {
 *     routes:[...] }                         default_route, timeout_ms, routes:[...] } } }
 */
import fs from 'node:fs';
import path from 'node:path';

function convert(cfg) {
  if (cfg.routers && typeof cfg.routers === 'object') return null; // already multi-router
  const name = cfg.live?.model_name ?? 'auto';
  const out = {
    classifier: cfg.classifier,
    live: { enabled: Boolean(cfg.live?.enabled) },
    routers: {
      [name]: {
        default_route: cfg.default_route,
        timeout_ms: cfg.live?.timeout_ms ?? 5000,
        routes: cfg.routes ?? [],
      },
    },
  };
  return out;
}

const argv = process.argv.slice(2);
const dry = argv.includes('--dry-run');
const i = argv.indexOf('--routing-dir');
const routingDir = i >= 0 && argv[i + 1] ? argv[i + 1] : 'data/litellm/routing';
const routesPath = path.join(routingDir, 'routes.json');

if (!fs.existsSync(routesPath)) {
  console.error(`no routes.json at ${routesPath}`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(routesPath, 'utf8'));
const out = convert(cfg);
if (!out) {
  console.log(`already multi-router (${Object.keys(cfg.routers).join(', ')}) — nothing to do.`);
  process.exit(0);
}
const name = Object.keys(out.routers)[0];
if (dry) {
  console.log(`would convert to routers: { "${name}": { ${out.routers[name].routes.length} routes } }`);
  process.exit(0);
}
const tmp = routesPath + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
fs.renameSync(tmp, routesPath);
console.log(`converted → multi-router with one profile "${name}". Add more under "routers".`);

export { convert };
