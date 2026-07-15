/**
 * System export/restore (Phase 2 of backup/import) — the whole install as one
 * streamable .tgz: a consistent central-DB snapshot plus every data tree that
 * isn't secret or rebuildable.
 *
 * Contract (extends the agent-transfer contract):
 *   - SECRETS AND HOST IDENTITY NEVER TRAVEL: .env, data/tls (private keys),
 *     data/env, sockets, the upgrade marker, OneCLI material — none are in
 *     the bundle. A restored install keeps ITS OWN identity and credentials.
 *   - The DB snapshot is taken with better-sqlite3's backup API — consistent
 *     while the host is live, no reader/writer races.
 *   - RESTORE IS REPLACE, NOT MERGE. Current state is moved aside (never
 *     deleted) to *.pre-restore-<ts>; the process then exits cleanly and the
 *     service manager boots it on the restored data. A bundle whose schema is
 *     NEWER than this install is refused (migrations only go forward).
 *   - Lean mode drops conversation state (transcripts, session DBs, shell
 *     snapshots) for a config-and-knowledge-only bundle.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import { CONVERSATION_DIRS, EXCLUDE_ALWAYS } from './agent-transfer.js';

export const SYSTEM_FORMAT = 'nanoclaw-system-export';
export const SYSTEM_VERSION = 1;

/** data/ subtrees that belong in a system bundle. Everything else stays home. */
export const DATA_TREES = ['v2-sessions', 'user-skills', 'skill-drafts', 'learning', 'litellm', 'webchat'];

export interface SystemExportManifest {
  format: typeof SYSTEM_FORMAT;
  version: number;
  createdAt: string;
  lean: boolean;
  counts: { agents: number; rooms: number; models: number; mcpServers: number; skillDrafts: number };
  schemaVersion: number;
}

export function buildSystemManifest(lean: boolean): SystemExportManifest {
  const db = getDb();
  const count = (sql: string): number => {
    try {
      return (db.prepare(sql).get() as { n: number }).n;
    } catch {
      return 0;
    }
  };
  return {
    format: SYSTEM_FORMAT,
    version: SYSTEM_VERSION,
    createdAt: new Date().toISOString(),
    lean,
    counts: {
      agents: count('SELECT COUNT(*) AS n FROM agent_groups'),
      rooms: count(`SELECT COUNT(*) AS n FROM messaging_groups WHERE channel_type = 'webchat'`),
      models: count('SELECT COUNT(*) AS n FROM webchat_models'),
      mcpServers: count('SELECT COUNT(*) AS n FROM webchat_mcp_servers'),
      skillDrafts: count('SELECT COUNT(*) AS n FROM skill_drafts'),
    },
    schemaVersion: count('SELECT COALESCE(MAX(version), 0) AS n FROM schema_version'),
  };
}

/** Stage manifest + consistent DB snapshot; returns the stage dir. */
export async function stageSystemExport(lean: boolean): Promise<string> {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-sysexport-'));
  fs.mkdirSync(path.join(stage, 'db'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(buildSystemManifest(lean), null, 2));
  await getDb().backup(path.join(stage, 'db', 'v2.db'));
  return stage;
}

export function systemTarArgs(stage: string, lean: boolean): string[] {
  const args = ['-cz', '--warning=no-file-changed', '--ignore-failed-read'];
  for (const e of EXCLUDE_ALWAYS) args.push(`--exclude=${e}`);
  if (lean) {
    for (const d of CONVERSATION_DIRS) args.push(`--exclude=.claude-shared/${d}`);
    args.push('--exclude=v2-sessions/*/sess-*');
    args.push('--exclude=conversations');
  }
  args.push('-C', stage, 'manifest.json', 'db');
  args.push(`--transform=s|^${path.basename(GROUPS_DIR)}|files/groups|`, '-C', path.dirname(GROUPS_DIR), path.basename(GROUPS_DIR));
  for (const tree of DATA_TREES) {
    if (fs.existsSync(path.join(DATA_DIR, tree))) {
      args.push(`--transform=s|^${tree}|files/data/${tree}|`, '-C', DATA_DIR, tree);
    }
  }
  return args;
}

/** Tar member validation for SYSTEM bundles (see agent-transfer for agents). */
export function isSafeSystemEntry(entry: string): boolean {
  if (!entry || entry.startsWith('/') || entry.includes('\\')) return false;
  if (entry.split('/').some((p) => p === '..')) return false;
  return (
    entry === 'manifest.json' ||
    entry === 'db' ||
    entry === 'db/' ||
    entry === 'db/v2.db' ||
    entry === 'files' ||
    entry === 'files/' ||
    entry.startsWith('files/groups') ||
    DATA_TREES.some((t) => entry.startsWith(`files/data/${t}`) || entry === `files/data/${t}` || entry === 'files/data/' || entry === 'files/data')
  );
}

export interface SystemPreview {
  manifest: SystemExportManifest;
  currentSchemaVersion: number;
  schemaOk: boolean;
}

export function previewSystemImport(bundleDir: string): SystemPreview {
  const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8')) as SystemExportManifest;
  if (manifest.format !== SYSTEM_FORMAT) throw new Error('Not a NanoClaw system export');
  if (manifest.version > SYSTEM_VERSION) throw new Error(`Export version ${manifest.version} is newer than this install understands`);
  const bundleDb = new Database(path.join(bundleDir, 'db', 'v2.db'), { readonly: true });
  let bundleSchema = 0;
  try {
    bundleSchema = (bundleDb.prepare('SELECT COALESCE(MAX(version), 0) AS n FROM schema_version').get() as { n: number }).n;
  } finally {
    bundleDb.close();
  }
  const current = (getDb().prepare('SELECT COALESCE(MAX(version), 0) AS n FROM schema_version').get() as { n: number }).n;
  return {
    manifest: { ...manifest, schemaVersion: bundleSchema },
    currentSchemaVersion: current,
    // Older-or-equal restores fine (boot migrations top it up); NEWER means
    // the bundle came from a more migrated install — refuse.
    schemaOk: bundleSchema <= current,
  };
}

/**
 * The point of no return. Kills agent containers, moves current state aside
 * (kept as *.pre-restore-<ts> for manual rollback), moves the bundle's state
 * in — then EXITS so the service manager boots the host on the restored
 * data. The caller must have responded to the client before invoking.
 */
export function executeSystemRestore(bundleDir: string, closeCentralDb: () => void): void {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  // 1. Containers down — they hold session DB mounts inside the trees we swap.
  try {
    const ps = spawn('bash', ['-c', "docker ps -q --filter name=nanoclaw-v2- | xargs -r docker kill"]);
    ps.on('close', () => undefined);
  } catch {
    /* containers die with their mounts regardless */
  }

  setTimeout(() => {
    try {
      closeCentralDb();
      // 2. Central DB (+ sidecars) aside, bundle DB in.
      for (const suffix of ['', '-wal', '-shm']) {
        const p = path.join(DATA_DIR, `v2.db${suffix}`);
        if (fs.existsSync(p)) fs.renameSync(p, `${p}.pre-restore-${ts}`);
      }
      fs.copyFileSync(path.join(bundleDir, 'db', 'v2.db'), path.join(DATA_DIR, 'v2.db'));
      // 3. Trees: aside + in (only trees the bundle actually carries).
      const swaps: [string, string][] = [[path.join(bundleDir, 'files', 'groups'), GROUPS_DIR]];
      for (const tree of DATA_TREES) {
        swaps.push([path.join(bundleDir, 'files', 'data', tree), path.join(DATA_DIR, tree)]);
      }
      for (const [src, dest] of swaps) {
        if (!fs.existsSync(src)) continue;
        if (fs.existsSync(dest)) fs.renameSync(dest, `${dest}.pre-restore-${ts}`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(src, dest);
      }
      log.info('System restore applied — exiting for a clean boot on restored data', { ts });
    } catch (err) {
      log.error('System restore failed mid-swap — pre-restore copies retained', { ts, err: String(err) });
    } finally {
      // Clean exit either way: a half-swapped process must not keep serving.
      process.exit(0);
    }
  }, 800);
}
