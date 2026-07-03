#!/usr/bin/env node
/**
 * Register a LiteLLM router's roster as webchat models (kind
 * `openai-compatible`), so each can be assigned to an agent from the Models
 * UI — which, with the provider-sync behavior, flips that agent onto the
 * OpenCode harness.
 *
 * Reads the roster live from the router's /v1/models, then upserts one
 * webchat_models row per model. Dedupe is by display name (the same rule the
 * UI's create form enforces): existing names are left untouched, so re-runs
 * after a roster change only add what's new.
 *
 * The endpoint is stored in its CONTAINER-FACING form
 * (http://host.docker.internal:<port>/v1) — that's what the agent consumes;
 * the webchat host side translates back to loopback for its own fetches.
 *
 * Usage:
 *   node register-models.mjs [--checkout /path/to/nanoclaw] [--port 4000] [--dry-run]
 *
 * Exit codes: 0 ok (also for "nothing new"), 1 failure.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

// ── pure mapping (unit-tested) ─────────────────────────────────────────────

/**
 * Map a /v1/models roster onto webchat_models candidate rows.
 * `existingNames` (display names already registered) are skipped.
 */
export function rosterToModelRows(rosterIds, endpoint, existingNames, now = 0) {
  const taken = new Set([...existingNames].map((n) => n.toLowerCase()));
  const rows = [];
  for (const modelId of rosterIds) {
    // Display name = the roster tag itself — short, unique, recognizable.
    const name = modelId;
    if (taken.has(name.toLowerCase())) continue;
    taken.add(name.toLowerCase());
    rows.push({
      id: randomUUID(),
      name,
      kind: 'openai-compatible',
      endpoint,
      model_id: modelId,
      credential_ref: null,
      created_at: now,
    });
  }
  return rows;
}

// ── CLI ────────────────────────────────────────────────────────────────────

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const checkout = path.resolve(arg('--checkout', process.cwd()));
  const port = Number(arg('--port', '4000'));
  const dryRun = process.argv.includes('--dry-run');

  // Roster from the router (host-side view).
  const rosterRes = await fetch(`http://127.0.0.1:${port}/v1/models`).catch((e) => {
    throw new Error(`LiteLLM not reachable on 127.0.0.1:${port} — is the router running? (${e.message})`);
  });
  if (!rosterRes.ok) throw new Error(`/v1/models returned HTTP ${rosterRes.status}`);
  const roster = (await rosterRes.json()).data?.map((m) => m.id) ?? [];
  if (roster.length === 0) throw new Error('Router is up but serves no models — check data/litellm/config.yaml');

  // DB via the checkout's own better-sqlite3 (no new dependency).
  const require = createRequire(path.join(checkout, 'package.json'));
  const Database = require('better-sqlite3');
  const db = new Database(path.join(checkout, 'data', 'v2.db'));
  try {
    const table = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='webchat_models'`).get();
    if (!table) throw new Error('webchat_models table missing — is the webchat channel installed and migrated?');

    const existing = db.prepare(`SELECT name FROM webchat_models`).all().map((r) => r.name);
    const endpoint = `http://host.docker.internal:${port}/v1`;
    const rows = rosterToModelRows(roster, endpoint, existing, Date.now());

    console.log(`Roster: ${roster.length} model(s); already registered: ${roster.length - rows.length}; new: ${rows.length}`);
    for (const row of rows) console.log(`  + ${row.name}  (${row.model_id} @ ${row.endpoint})`);
    if (dryRun || rows.length === 0) {
      if (dryRun) console.log('(dry-run — nothing written)');
      return;
    }
    const insert = db.prepare(
      `INSERT INTO webchat_models (id, name, kind, endpoint, model_id, credential_ref, created_at)
       VALUES (@id, @name, @kind, @endpoint, @model_id, @credential_ref, @created_at)`,
    );
    const tx = db.transaction((all) => all.forEach((r) => insert.run(r)));
    tx(rows);
    console.log(`Registered ${rows.length} model(s). Assign one from the webchat Models UI to switch that agent to OpenCode.`);
  } finally {
    db.close();
  }
}

// Run only as a CLI — imports (the test) get the pure function without side effects.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`register-models: ${err.message}`);
    process.exit(1);
  });
}
