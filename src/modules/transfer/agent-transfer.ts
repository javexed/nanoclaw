/**
 * Agent export/import (Phase 1 of backup/import) — a portable, selective
 * .tgz of ONE agent: identity, container config, instructions, workspace,
 * memory, scoped skills, wiring/attachments BY REFERENCE, and (opt-in) the
 * conversation state.
 *
 * Design contract:
 *   - SECRETS NEVER EXPORT. No .env, no OneCLI material, no MCP headers or
 *     relay tokens; container_config.mcp_servers is emptied and re-derived on
 *     import from the target install's registry. The manifest names what the
 *     target must supply instead (requiredCredentials).
 *   - Cross-entity links travel BY REFERENCE (room platform ids, MCP server
 *     names, model kind+endpoint+model_id) and re-link on import when the
 *     target has a match; misses are reported, never guessed.
 *   - Import is CLONE-semantics: a fresh agent id, folder auto-suffixed on
 *     collision. Restoring after an accidental delete is just a clone that
 *     happens to find all its references again.
 *   - Streams both ways (workspaces are ~GB): export pipes `tar -cz` to the
 *     response; import spools the upload to a temp file before extraction.
 *   - Junk never travels: node_modules, .git, caches (EXCLUDE_ALWAYS).
 */
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { getAgentGroup, createAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig, ensureContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { log } from '../../log.js';

export const EXPORT_FORMAT = 'nanoclaw-agent-export';
export const EXPORT_VERSION = 1;

/** Rebuildable or install-specific trees that never belong in a bundle. */
export const EXCLUDE_ALWAYS = ['node_modules', '.git', '__pycache__', 'dist', '.venv'];
/** Conversation state — only travels when the operator opts in. */
export const CONVERSATION_DIRS = ['projects', 'sessions', 'shell-snapshots', 'backups', 'session-env'];

export interface AgentExportManifest {
  format: typeof EXPORT_FORMAT;
  version: number;
  createdAt: string;
  entity: { id: string; name: string; folder: string };
  includesConversations: boolean;
  /** What the TARGET install must supply — secrets never travel. */
  requiredCredentials: string[];
  references: {
    rooms: { channel_type: string; platform_id: string; instance: string | null }[];
    mcpServers: string[];
    model: { kind: string; endpoint: string | null; model_id: string } | null;
  };
}

/**
 * Validate one tar member path from an untrusted bundle. Anything absolute,
 * traversal-shaped, or outside the expected roots is rejected — extraction
 * happens with our own file writes, never blind `tar -x` into live dirs.
 */
export function isSafeTarEntry(entry: string): boolean {
  if (!entry || entry.startsWith('/') || entry.includes('\\')) return false;
  const parts = entry.split('/');
  if (parts.some((p) => p === '..' || p === '')) return entry.endsWith('/') && !parts.slice(0, -1).some((p) => p === '..' || p === '');
  return (
    entry === 'manifest.json' ||
    entry.startsWith('db/') ||
    entry.startsWith('files/workspace/') ||
    entry.startsWith('files/claude-shared/') ||
    entry.startsWith('files/session-dbs/') ||
    entry === 'db' ||
    entry === 'files' ||
    entry.startsWith('files/workspace') ||
    entry.startsWith('files/claude-shared') ||
    entry.startsWith('files/session-dbs')
  );
}

/** Insert a row keeping only columns the TARGET schema actually has. */
export function insertWithSchemaIntersection(table: string, row: Record<string, unknown>): void {
  const db = getDb();
  const cols = new Set(
    (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((c) => c.name),
  );
  const keys = Object.keys(row).filter((k) => cols.has(k));
  db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => '@' + k).join(', ')})`).run(
    Object.fromEntries(keys.map((k) => [k, row[k]])) as Record<string, unknown>,
  );
}

// ── Export ───────────────────────────────────────────────────────────────────

/** Stage the small parts (manifest + DB slices) into a temp dir; return it. */
export function stageAgentExport(agentGroupId: string, includeConversations: boolean): string {
  const db = getDb();
  const group = getAgentGroup(agentGroupId);
  if (!group) throw new Error('Agent not found');
  const cfg = getContainerConfig(agentGroupId);

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-export-'));
  fs.mkdirSync(path.join(stage, 'db'), { recursive: true });

  const required: string[] = [];

  // container config, secrets stripped: mcp_servers is DERIVED state on the
  // target (attachments re-sync it); anything inside can carry tokens.
  const cfgOut = cfg ? { ...cfg } : null;
  if (cfgOut) {
    const entries = Object.keys(JSON.parse(cfgOut.mcp_servers || '{}') as Record<string, unknown>);
    if (entries.length > 0) required.push(`MCP server config for: ${entries.join(', ')} (re-attach on the target)`);
    cfgOut.mcp_servers = '{}';
  }

  const wirings = db
    .prepare(
      `SELECT mga.*, mg.channel_type, mg.platform_id, mg.instance
       FROM messaging_group_agents mga JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
       WHERE mga.agent_group_id = ?`,
    )
    .all(agentGroupId) as Record<string, unknown>[];

  const mcpNames = (
    db
      .prepare(
        `SELECT s.name FROM webchat_mcp_servers s
         JOIN webchat_agent_mcp_servers a ON a.mcp_server_id = s.id WHERE a.agent_group_id = ?`,
      )
      .all(agentGroupId) as { name: string }[]
  ).map((r) => r.name);

  const model = db
    .prepare(
      `SELECT m.kind, m.endpoint, m.model_id, m.credential_ref FROM webchat_models m
       JOIN webchat_agent_models am ON am.model_id = m.id WHERE am.agent_group_id = ?`,
    )
    .get(agentGroupId) as { kind: string; endpoint: string | null; model_id: string; credential_ref: string | null } | undefined;
  if (model?.credential_ref) required.push(`model credential: ${model.credential_ref}`);

  const destinations = db
    .prepare(`SELECT * FROM agent_destinations WHERE agent_group_id = ?`)
    .all(agentGroupId) as Record<string, unknown>[];

  const manifest: AgentExportManifest = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    createdAt: new Date().toISOString(),
    entity: { id: group.id, name: group.name, folder: group.folder },
    includesConversations: includeConversations,
    requiredCredentials: required,
    references: {
      rooms: wirings.map((w) => ({
        channel_type: String(w.channel_type),
        platform_id: String(w.platform_id),
        instance: (w.instance as string | null) ?? null,
      })),
      mcpServers: mcpNames,
      model: model ? { kind: model.kind, endpoint: model.endpoint, model_id: model.model_id } : null,
    },
  };

  const write = (name: string, data: unknown) =>
    fs.writeFileSync(path.join(stage, name), JSON.stringify(data, null, 2));
  write('manifest.json', manifest);
  write('db/agent_group.json', group);
  write('db/container_config.json', cfgOut);
  write('db/wirings.json', wirings);
  write('db/destinations.json', destinations);
  return stage;
}

/** tar args that stream the full bundle: staged small files + big trees live. */
export function exportTarArgs(stage: string, group: { id: string; folder: string }, includeConversations: boolean): string[] {
  const sessRoot = path.join(DATA_DIR, 'v2-sessions', group.id);
  const args = ['-cz', '--warning=no-file-changed'];
  for (const e of EXCLUDE_ALWAYS) args.push(`--exclude=${e}`);
  if (!includeConversations) {
    for (const d of CONVERSATION_DIRS) args.push(`--exclude=.claude-shared/${d}`);
  }
  args.push('-C', stage, 'manifest.json', 'db');
  if (fs.existsSync(path.join(GROUPS_DIR, group.folder))) {
    args.push(`--transform=s|^${group.folder}|files/workspace|`, '-C', GROUPS_DIR, group.folder);
  }
  if (fs.existsSync(path.join(sessRoot, '.claude-shared'))) {
    args.push('--transform=s|^\\.claude-shared|files/claude-shared|', '-C', sessRoot, '.claude-shared');
  }
  if (includeConversations && fs.existsSync(sessRoot)) {
    for (const entry of fs.readdirSync(sessRoot)) {
      if (entry.startsWith('sess-')) {
        args.push(`--transform=s|^${entry}|files/session-dbs/${entry}|`, '-C', sessRoot, entry);
      }
    }
  }
  return args;
}

// ── Import ───────────────────────────────────────────────────────────────────

export interface ImportPreview {
  manifest: AgentExportManifest;
  suggestedName: string;
  suggestedFolder: string;
  rooms: { platform_id: string; found: boolean }[];
  mcpServers: { name: string; found: boolean }[];
  modelFound: boolean;
}

const uniqueFolder = (base: string): string => {
  let f = base;
  let i = 2;
  while (fs.existsSync(path.join(GROUPS_DIR, f))) f = `${base}-${i++}`;
  return f;
};

export function previewImport(bundleDir: string): ImportPreview {
  const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8')) as AgentExportManifest;
  if (manifest.format !== EXPORT_FORMAT) throw new Error('Not a NanoClaw agent export');
  if (manifest.version > EXPORT_VERSION) throw new Error(`Export version ${manifest.version} is newer than this install understands`);
  const db = getDb();
  const rooms = manifest.references.rooms.map((r) => ({
    platform_id: r.platform_id,
    found: !!getMessagingGroupByPlatform(r.channel_type, r.platform_id),
  }));
  const mcpServers = manifest.references.mcpServers.map((name) => ({
    name,
    found: !!db.prepare(`SELECT 1 FROM webchat_mcp_servers WHERE name = ?`).get(name),
  }));
  const m = manifest.references.model;
  const modelFound = !m
    ? true
    : !!db
        .prepare(`SELECT 1 FROM webchat_models WHERE kind = ? AND model_id = ? AND (endpoint IS ? OR endpoint = ?)`)
        .get(m.kind, m.model_id, m.endpoint, m.endpoint);
  const nameTaken = !!db.prepare(`SELECT 1 FROM agent_groups WHERE name = ?`).get(manifest.entity.name);
  return {
    manifest,
    suggestedName: nameTaken ? `${manifest.entity.name} (imported)` : manifest.entity.name,
    suggestedFolder: uniqueFolder(manifest.entity.folder),
    rooms,
    mcpServers,
    modelFound,
  };
}

export interface ApplyResult {
  id: string;
  name: string;
  folder: string;
  linkedRooms: string[];
  skippedRooms: string[];
  attachedMcp: string[];
  modelAssigned: boolean;
  destinationsImported: number;
  destinationsSkipped: number;
}

export function applyImport(bundleDir: string, opts: { name?: string } = {}): ApplyResult {
  const db = getDb();
  const preview = previewImport(bundleDir);
  const manifest = preview.manifest;
  const name = (opts.name || preview.suggestedName).trim().slice(0, 80);
  const folder = preview.suggestedFolder;
  const readJson = <T>(rel: string): T | null => {
    try {
      return JSON.parse(fs.readFileSync(path.join(bundleDir, rel), 'utf8')) as T;
    } catch {
      return null;
    }
  };

  // All DB writes commit atomically; file copies happen only after commit —
  // a failed apply leaves no half-imported rows.
  const id = `a${randomUUID()}`;
  const linkedRooms: string[] = [];
  const skippedRooms: string[] = [];
  const attachedMcp: string[] = [];
  let modelAssigned = false;
  let destinationsImported = 0;
  let destinationsTotal = 0;
  db.transaction(() => {
  createAgentGroup({
    id,
    name,
    folder,
    agent_provider: null,
    created_at: new Date().toISOString(),
  } as Parameters<typeof createAgentGroup>[0]);

  // 2. Container config: schema-intersection insert under the new id;
  //    mcp_servers stays empty (attachments re-derive it below).
  const cfgRow = readJson<Record<string, unknown>>('db/container_config.json');
  ensureContainerConfig(id);
  if (cfgRow) {
    db.prepare(`DELETE FROM container_configs WHERE agent_group_id = ?`).run(id);
    insertWithSchemaIntersection('container_configs', { ...cfgRow, agent_group_id: id });
  }

  // 4. Re-link rooms by platform reference.
  const wirings = readJson<Record<string, unknown>[]>('db/wirings.json') ?? [];
  for (const w of wirings) {
    const mg = getMessagingGroupByPlatform(String(w.channel_type), String(w.platform_id));
    if (!mg) {
      skippedRooms.push(String(w.platform_id));
      continue;
    }
    const { channel_type: _c, platform_id: _p, instance: _i, ...row } = w;
    // Fresh PK: the exported row's id belongs to the SOURCE wiring, which may
    // still exist on this install (clone next to the original).
    insertWithSchemaIntersection('messaging_group_agents', {
      ...row,
      id: randomUUID(),
      agent_group_id: id,
      messaging_group_id: mg.id,
    });
    linkedRooms.push(String(w.platform_id));
  }

  // 5. Destinations — only those whose target still exists here.
  const destinations = readJson<Record<string, unknown>[]>('db/destinations.json') ?? [];
  destinationsTotal = destinations.length;
  for (const d of destinations) {
    if (d.target_type === 'agent' && !getAgentGroup(String(d.target_id))) continue;
    try {
      insertWithSchemaIntersection('agent_destinations', { ...d, id: randomUUID(), agent_group_id: id });
      destinationsImported++;
    } catch (err) {
      log.warn('Import: destination row skipped', { err: String(err) });
    }
  }

  // 6. MCP attachments by name (config re-derived by the caller's sync).
  for (const { name: mcpName, found } of preview.mcpServers) {
    if (!found) continue;
    const s = db.prepare(`SELECT id FROM webchat_mcp_servers WHERE name = ?`).get(mcpName) as { id: string } | undefined;
    if (!s) continue;
    db.prepare(
      `INSERT INTO webchat_agent_mcp_servers (agent_group_id, mcp_server_id, assigned_at)
       VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    ).run(id, s.id, Date.now());
    attachedMcp.push(mcpName);
  }
  updateContainerConfigJson(id, 'mcp_servers', {}); // clean base; caller syncs

  // 7. Model by reference.
  const m = manifest.references.model;
  if (m) {
    const row = db
      .prepare(`SELECT id FROM webchat_models WHERE kind = ? AND model_id = ? AND (endpoint IS ? OR endpoint = ?)`)
      .get(m.kind, m.model_id, m.endpoint, m.endpoint) as { id: string } | undefined;
    if (row) {
      db.prepare(
        `INSERT INTO webchat_agent_models (agent_group_id, model_id, assigned_at) VALUES (?, ?, ?)
         ON CONFLICT(agent_group_id) DO UPDATE SET model_id = excluded.model_id`,
      ).run(id, row.id, Date.now());
      modelAssigned = true;
    }
  }
  })(); // ── end atomic DB phase

  // 3. Files.
  const sessRoot = path.join(DATA_DIR, 'v2-sessions', id);
  const copies: [string, string][] = [
    [path.join(bundleDir, 'files', 'workspace'), path.join(GROUPS_DIR, folder)],
    [path.join(bundleDir, 'files', 'claude-shared'), path.join(sessRoot, '.claude-shared')],
  ];
  const sessSrc = path.join(bundleDir, 'files', 'session-dbs');
  if (fs.existsSync(sessSrc)) {
    for (const s of fs.readdirSync(sessSrc)) copies.push([path.join(sessSrc, s), path.join(sessRoot, s)]);
  }
  for (const [src, dest] of copies) {
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
  }
  // The materialized container.json is install-derived — never import it.
  fs.rmSync(path.join(GROUPS_DIR, folder, 'container.json'), { force: true });

  return {
    id,
    name,
    folder,
    linkedRooms,
    skippedRooms,
    attachedMcp,
    modelAssigned,
    destinationsImported,
    destinationsSkipped: destinationsTotal - destinationsImported,
  };
}

/** Extract an uploaded bundle safely: list first, reject bad members, then extract. */
export async function extractBundle(tgzPath: string): Promise<string> {
  const listing = await new Promise<string>((resolve, reject) => {
    const p = spawn('tar', ['-tzf', tgzPath]);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`tar -t failed: ${err.slice(0, 200)}`))));
  });
  const bad = listing.split('\n').filter(Boolean).filter((e) => !isSafeTarEntry(e));
  if (bad.length > 0) throw new Error(`Bundle contains unsafe paths: ${bad.slice(0, 3).join(', ')}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-import-'));
  await new Promise<void>((resolve, reject) => {
    const p = spawn('tar', ['-xzf', tgzPath, '-C', dir, '--no-same-owner']);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar -x failed: ${err.slice(0, 200)}`))));
  });
  return dir;
}
