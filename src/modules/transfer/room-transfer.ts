/**
 * Room export/import (Phase 3 of backup/import) — one webchat room as a
 * portable .tgz: the messaging group, room settings, threads, the FULL
 * message history, per-room learning settings, uploaded files, and its
 * agent wiring BY REFERENCE (agents match by folder on import).
 *
 * Same contract as the other transfer scopes:
 *   - no secrets (rooms hold none — user-specific state like reads/pins/
 *     hides deliberately stays home: it belongs to THIS install's users);
 *   - references re-link on exact match and report misses;
 *   - import is clone-semantics: the room slug is kept when free, suffixed
 *     when taken; all DB writes are one transaction, files copy after.
 *
 * Message history rides as JSON; the FTS index is NOT exported — the
 * webchat_messages_fts_* triggers rebuild it row-by-row as messages insert.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { insertWithSchemaIntersection } from './agent-transfer.js';

export const ROOM_FORMAT = 'nanoclaw-room-export';
export const ROOM_VERSION = 1;

/** Room-scoped tables exported wholesale (keyed by room_id). */
const ROOM_TABLES = ['webchat_messages', 'webchat_threads', 'webchat_room_settings', 'webchat_room_primes', 'webchat_thread_engaged', 'webchat_thread_sync'];

export interface RoomExportManifest {
  format: typeof ROOM_FORMAT;
  version: number;
  createdAt: string;
  entity: { roomId: string; name: string };
  counts: { messages: number; threads: number; files: number };
  references: { agents: { name: string; folder: string }[] };
}

export function isSafeRoomEntry(entry: string): boolean {
  if (!entry || entry.startsWith('/') || entry.includes('\\')) return false;
  if (entry.split('/').some((p) => p === '..')) return false;
  return (
    entry === 'manifest.json' ||
    entry === 'db' ||
    entry === 'db/' ||
    entry.startsWith('db/') ||
    entry === 'files' ||
    entry === 'files/' ||
    entry === 'files/uploads' ||
    entry.startsWith('files/uploads/')
  );
}

function uploadsDirFor(roomId: string): string {
  // Mirrors files.ts uploadsDir without importing webchat internals into the
  // transfer module (same sanitization contract: the id is a slug already).
  return path.join(DATA_DIR, 'webchat', 'uploads', roomId);
}

/** Stage the whole room bundle (rooms are small enough to stage fully). */
export function stageRoomExport(roomId: string): { stage: string; manifest: RoomExportManifest } {
  const db = getDb();
  const mg = getMessagingGroupByPlatform('webchat', roomId);
  if (!mg) throw new Error('Room not found');

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-roomexport-'));
  fs.mkdirSync(path.join(stage, 'db'), { recursive: true });

  const write = (name: string, data: unknown) =>
    fs.writeFileSync(path.join(stage, 'db', name), JSON.stringify(data, null, 1));

  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const t of ROOM_TABLES) {
    try {
      tables[t] = db.prepare(`SELECT * FROM ${t} WHERE room_id = ?`).all(roomId) as Record<string, unknown>[];
    } catch {
      tables[t] = []; // table absent on this install — fine
    }
    write(`${t}.json`, tables[t]);
  }

  const wirings = db
    .prepare(`SELECT * FROM messaging_group_agents WHERE messaging_group_id = ?`)
    .all(mg.id) as Record<string, unknown>[];
  const agents = wirings
    .map((w) => getAgentGroup(String(w.agent_group_id)))
    .filter((a): a is NonNullable<typeof a> => !!a)
    .map((a) => ({ name: a.name, folder: a.folder }));
  write('messaging_group.json', mg);
  write('wirings.json', wirings);

  let learning: Record<string, unknown> | null = null;
  try {
    learning = (db.prepare(`SELECT * FROM learning_room_settings WHERE messaging_group_id = ?`).get(mg.id) ?? null) as
      | Record<string, unknown>
      | null;
  } catch {
    /* module table absent */
  }
  write('learning.json', learning);

  let files = 0;
  try {
    files = fs.readdirSync(uploadsDirFor(roomId)).length;
  } catch {
    /* no uploads */
  }

  const manifest: RoomExportManifest = {
    format: ROOM_FORMAT,
    version: ROOM_VERSION,
    createdAt: new Date().toISOString(),
    entity: { roomId, name: mg.name ?? roomId },
    counts: { messages: tables.webchat_messages.length, threads: tables.webchat_threads.length, files },
    references: { agents },
  };
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { stage, manifest };
}

export function roomTarArgs(stage: string, roomId: string): string[] {
  const args = ['-cz', '--warning=no-file-changed', '-C', stage, 'manifest.json', 'db'];
  const uploads = uploadsDirFor(roomId);
  if (fs.existsSync(uploads)) {
    args.push(`--transform=s|^${roomId}|files/uploads|`, '-C', path.dirname(uploads), roomId);
  }
  return args;
}

export interface RoomImportPreview {
  manifest: RoomExportManifest;
  suggestedRoomId: string;
  agents: { name: string; folder: string; found: boolean }[];
}

const uniqueRoomId = (base: string): string => {
  let id = base;
  let i = 2;
  while (getMessagingGroupByPlatform('webchat', id)) id = `${base}-${i++}`;
  return id;
};

export function previewRoomImport(bundleDir: string): RoomImportPreview {
  const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8')) as RoomExportManifest;
  if (manifest.format !== ROOM_FORMAT) throw new Error('Not a NanoClaw room export');
  if (manifest.version > ROOM_VERSION) throw new Error(`Export version ${manifest.version} is newer than this install understands`);
  const db = getDb();
  const agents = manifest.references.agents.map((a) => ({
    ...a,
    found: !!db.prepare(`SELECT 1 FROM agent_groups WHERE folder = ?`).get(a.folder),
  }));
  return { manifest, suggestedRoomId: uniqueRoomId(manifest.entity.roomId), agents };
}

export interface RoomApplyResult {
  roomId: string;
  name: string;
  messages: number;
  threads: number;
  wiredAgents: string[];
  skippedAgents: string[];
  filesCopied: boolean;
}

export function applyRoomImport(bundleDir: string): RoomApplyResult {
  const db = getDb();
  const preview = previewRoomImport(bundleDir);
  const roomId = preview.suggestedRoomId;
  const readJson = <T>(rel: string): T =>
    JSON.parse(fs.readFileSync(path.join(bundleDir, 'db', rel), 'utf8')) as T;

  const mgRow = readJson<Record<string, unknown>>('messaging_group.json');
  const wirings = readJson<Record<string, unknown>[]>('wirings.json');
  const learning = readJson<Record<string, unknown> | null>('learning.json');

  const wiredAgents: string[] = [];
  const skippedAgents: string[] = [];
  let messages = 0;
  let threads = 0;

  db.transaction(() => {
    const mgId = `mg-${Date.now()}-${randomUUID().slice(0, 6)}`;
    insertWithSchemaIntersection('messaging_groups', {
      ...mgRow,
      id: mgId,
      platform_id: roomId,
      created_at: new Date().toISOString(),
    });

    for (const t of ROOM_TABLES) {
      let rows: Record<string, unknown>[] = [];
      try {
        rows = readJson<Record<string, unknown>[]>(`${t}.json`);
      } catch {
        continue;
      }
      for (const row of rows) {
        try {
          // Message ids are a GLOBAL primary key — a clone (same install or a
          // re-import) must mint fresh ones or every row collides silently.
          // Thread ids stay: they're scoped by room_id and messages reference
          // them within the bundle.
          const remapped = t === 'webchat_messages' ? { ...row, id: randomUUID(), room_id: roomId } : { ...row, room_id: roomId };
          insertWithSchemaIntersection(t, remapped);
          if (t === 'webchat_messages') messages++;
          if (t === 'webchat_threads') threads++;
        } catch {
          /* per-row tolerance — a single bad row must not sink the room */
        }
      }
    }

    // wirings[] and manifest.references.agents[] were built from the same
    // list in the same order at export time — pair by index, resolve the
    // folder on THIS install. Works same-install and cross-install alike.
    wirings.forEach((w, i) => {
      const folder = preview.agents[i]?.folder;
      const target = folder
        ? (db.prepare(`SELECT id FROM agent_groups WHERE folder = ?`).get(folder) as { id: string } | undefined)
        : undefined;
      if (!target) {
        if (folder) skippedAgents.push(folder);
        return;
      }
      insertWithSchemaIntersection('messaging_group_agents', {
        ...w,
        id: randomUUID(),
        messaging_group_id: mgId,
        agent_group_id: target.id,
      });
      if (folder) wiredAgents.push(folder);
    });

    if (learning) {
      try {
        insertWithSchemaIntersection('learning_room_settings', { ...learning, messaging_group_id: mgId });
      } catch {
        /* module table absent here */
      }
    }
  })();

  // Files after commit.
  let filesCopied = false;
  const src = path.join(bundleDir, 'files', 'uploads');
  if (fs.existsSync(src)) {
    fs.cpSync(src, uploadsDirFor(roomId), { recursive: true });
    filesCopied = true;
  }

  return {
    roomId,
    name: String(mgRow.name ?? roomId),
    messages,
    threads,
    wiredAgents,
    skippedAgents,
    filesCopied,
  };
}
