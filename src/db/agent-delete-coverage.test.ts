/**
 * Delete-cascade coverage — the regression class this guards:
 * "delete X, leave Y dangling". Three real instances in two days:
 *   - webchat agent delete vs container_configs/user_roles/… (FK abort),
 *   - ncl groups delete vs skill_drafts / agent_message_policies,
 *   - model delete vs routing rules (different store, same failure).
 *
 * The durable check is structural: enumerate every table whose SCHEMA
 * references agent_groups (from a freshly migrated DB — the single source of
 * truth), and require BOTH delete implementations to name each one. A new
 * migration that adds a referencing table turns this red until both cascades
 * learn it — at review time, not in production as a 500.
 *
 * Source-containment is deliberate: the handlers are embedded in route/CLI
 * plumbing and not unit-invokable without a full server harness. Naming the
 * table is the invariant that actually rots.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDb, initDb } from './index.js';
import { runMigrations } from './migrations/index.js';
import { getDb } from './connection.js';

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-cov-'));
  initDb(path.join(tmp, 'test.db'));
  runMigrations(getDb());
});

afterAll(() => {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function referencingTables(): string[] {
  return (
    getDb()
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'table' AND name != 'agent_groups'
           AND (sql LIKE '%REFERENCES agent_groups%' OR sql LIKE '%REFERENCES "agent_groups"%')`,
      )
      .all() as { name: string; sql: string }[]
  ).map((r) => r.name);
}

const IMPLEMENTATIONS = [
  { label: 'webchat deleteAgentHandler', file: 'src/channels/webchat/server.ts' },
  { label: 'ncl groups delete', file: 'src/cli/resources/groups.ts' },
];

describe('agent-delete cascade coverage', () => {
  it('the schema actually has FK-referencing tables (sanity)', () => {
    const tables = referencingTables();
    expect(tables).toContain('container_configs');
    expect(tables).toContain('skill_drafts');
    expect(tables.length).toBeGreaterThanOrEqual(8);
  });

  for (const impl of IMPLEMENTATIONS) {
    it(`${impl.label} names every table that FK-references agent_groups`, () => {
      const src = fs.readFileSync(path.join(process.cwd(), impl.file), 'utf8');
      const missing = referencingTables().filter((t) => !src.includes(t));
      expect(
        missing,
        `Tables FK-referencing agent_groups but never mentioned in ${impl.file} — ` +
          `add them to its delete cascade (and to the other implementation): ${missing.join(', ')}`,
      ).toEqual([]);
    });
  }
});
