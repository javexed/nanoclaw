/**
 * Migrate rooms, agents, and message history from a NanoClaw v1 webchat
 * install into v2.
 *
 * Reads two v1 SQLite databases (read-only):
 *   - <v1>/data/chat.sqlite       — webchat rooms, messages, push subs
 *   - <v1>/store/messages.db      — registered_groups (room ↔ folder map)
 *
 * Writes into v2's central DB (data/v2.db) — safe to run while the service
 * is up because v2 runs sqlite in WAL mode. Every step is idempotent: re-runs
 * skip rows that already exist by their natural key (folder, platform_id,
 * message uuid, push endpoint).
 *
 * For each v1 room we create:
 *   - agent_groups row (folder taken from v1 registered_groups.folder)
 *   - groups/<folder>/ on disk via initGroupFilesystem (seeded with v1
 *     groups/main/CLAUDE.md content as the per-group instructions when the
 *     v1 install didn't customize the persona per agent)
 *   - messaging_groups row (channel_type='webchat', platform_id=<v1 slug>)
 *   - messaging_group_agents wiring (engage='.' = respond to all; mirrors v1
 *     `requires_trigger=0`)
 *   - agent_group_members row for --owner (idempotent)
 *
 * Then bulk-copies chat_messages → webchat_messages preserving id (UUID,
 * collision-safe) so re-runs INSERT OR IGNORE cleanly.
 *
 * Optional flags also copy push subscriptions and register an Ollama model.
 *
 * NOTE: v1 file uploads (message_type='file') reference paths under v1's
 * groups/<folder>/uploads which weren't migrated. The messages and file_meta
 * are preserved as history; the file URLs will 404 until/unless files are
 * copied separately. We log a count so this is visible.
 *
 * Usage:
 *   pnpm exec tsx scripts/migrate-from-webchat-v1.ts \
 *     [--from ~/nanoclaw-webchat-v1] \
 *     [--owner webchat:tailscale:foo@bar.com] \
 *     [--ollama-endpoint http://192.168.1.127:11434 --ollama-model llama3.2:latest] \
 *     [--dry-run] [--no-messages] [--no-push]
 *
 * Defaults:
 *   --from   : ~/nanoclaw-webchat-v1
 *   --owner  : the single global owner found in v2's user_roles, if unambiguous
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb, getDb } from '../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { initGroupFilesystem } from '../src/group-init.js';
import { addMember } from '../src/modules/permissions/db/agent-group-members.js';
import {
  assignModelToAgent,
  createWebchatModel,
  listWebchatModels,
} from '../src/channels/webchat/db.js';

interface Args {
  from: string;
  owner: string | null;
  ollamaEndpoint: string | null;
  ollamaModel: string | null;
  dryRun: boolean;
  noMessages: boolean;
  noPush: boolean;
}

interface V1Room {
  id: string; // slug, e.g. "control"
  name: string;
  created_at: number; // unix seconds
}

interface V1RegisteredGroup {
  jid: string; // e.g. "chat:control"
  name: string;
  folder: string; // e.g. "local_control"
}

interface V1Message {
  id: string;
  room_id: string;
  sender: string;
  sender_type: string;
  content: string;
  message_type: string;
  file_meta: string | null;
  created_at: number; // ms
}

interface V1PushSub {
  endpoint: string;
  identity: string;
  keys_json: string;
  created_at: number;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {
    from: path.join(os.homedir(), 'nanoclaw-webchat-v1'),
    owner: null,
    ollamaEndpoint: null,
    ollamaModel: null,
    dryRun: false,
    noMessages: false,
    noPush: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--from':
        out.from = v;
        i++;
        break;
      case '--owner':
        out.owner = v;
        i++;
        break;
      case '--ollama-endpoint':
        out.ollamaEndpoint = v;
        i++;
        break;
      case '--ollama-model':
        out.ollamaModel = v;
        i++;
        break;
      case '--dry-run':
        out.dryRun = true;
        break;
      case '--no-messages':
        out.noMessages = true;
        break;
      case '--no-push':
        out.noPush = true;
        break;
    }
  }
  return out as Args;
}

function openV1(dbPath: string): Database.Database {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`v1 DB not found at ${dbPath}`);
  }
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function readDefaultInstructions(fromRoot: string): string {
  const candidates = [
    path.join(fromRoot, 'groups', 'main', 'CLAUDE.md'),
    path.join(fromRoot, 'groups', 'global', 'CLAUDE.md'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, 'utf-8');
    }
  }
  return '# Agent\n\nYou are a helpful personal assistant.\n';
}

function readPerGroupInstructions(fromRoot: string, folder: string, fallback: string): string {
  const local = path.join(fromRoot, 'groups', folder, 'CLAUDE.md');
  if (fs.existsSync(local)) {
    return fs.readFileSync(local, 'utf-8');
  }
  return fallback;
}

function resolveOwner(explicit: string | null): string {
  if (explicit) return explicit;
  const owners = getDb()
    .prepare(`SELECT user_id FROM user_roles WHERE role='owner' AND agent_group_id IS NULL`)
    .all() as { user_id: string }[];
  if (owners.length === 0) {
    throw new Error(
      `No global owner found in user_roles. Pass --owner <user-id> explicitly ` +
        `(e.g. --owner webchat:tailscale:foo@bar.com).`,
    );
  }
  if (owners.length > 1) {
    throw new Error(
      `Multiple global owners (${owners.map((o) => o.user_id).join(', ')}). ` +
        `Pass --owner explicitly to disambiguate.`,
    );
  }
  return owners[0].user_id;
}

function ensureAgentGroup(
  folder: string,
  name: string,
  now: string,
  fromRoot: string,
  defaultInstructions: string,
  dryRun: boolean,
): string {
  const existing = getAgentGroupByFolder(folder);
  if (existing) {
    console.log(`  agent group exists: ${existing.id} (${folder})`);
    if (!dryRun) {
      initGroupFilesystem(existing); // idempotent — no-op if files already there
    }
    return existing.id;
  }
  const id = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (dryRun) {
    console.log(`  [dry] create agent group: ${id} (${folder})`);
    return id;
  }
  createAgentGroup({ id, name, folder, agent_provider: null, created_at: now });
  const ag = getAgentGroupByFolder(folder)!;
  initGroupFilesystem(ag, {
    instructions: readPerGroupInstructions(fromRoot, folder, defaultInstructions),
  });
  console.log(`  created agent group: ${ag.id} (${folder})`);
  return ag.id;
}

function ensureMessagingGroup(slug: string, name: string, createdAt: number, dryRun: boolean): string {
  const existing = getMessagingGroupByPlatform('webchat', slug);
  if (existing) {
    console.log(`  messaging group exists: ${existing.id} (webchat:${slug})`);
    return existing.id;
  }
  const id = randomUUID();
  const createdAtIso = new Date(createdAt * 1000).toISOString();
  if (dryRun) {
    console.log(`  [dry] create messaging group: ${id} (webchat:${slug})`);
    return id;
  }
  createMessagingGroup({
    id,
    channel_type: 'webchat',
    platform_id: slug,
    name,
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: createdAtIso,
  });
  console.log(`  created messaging group: ${id} (webchat:${slug})`);
  return id;
}

function ensureWiring(mgId: string, agId: string, now: string, dryRun: boolean): void {
  const existing = getMessagingGroupAgentByPair(mgId, agId);
  if (existing) {
    console.log(`  wiring exists: ${existing.id}`);
    return;
  }
  if (dryRun) {
    console.log(`  [dry] create wiring ${mgId} -> ${agId}`);
    return;
  }
  createMessagingGroupAgent({
    id: `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    messaging_group_id: mgId,
    agent_group_id: agId,
    engage_mode: 'pattern',
    engage_pattern: '.', // v1 had requires_trigger=0 for every webchat group
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now,
  });
  console.log(`  wired ${mgId} -> ${agId}`);
}

function ensureMembership(userId: string, agId: string, now: string, dryRun: boolean): void {
  if (dryRun) {
    console.log(`  [dry] add membership ${userId} -> ${agId}`);
    return;
  }
  addMember({ user_id: userId, agent_group_id: agId, added_by: null, added_at: now });
}

function copyMessages(v1: Database.Database, dryRun: boolean): { inserted: number; skipped: number; files: number } {
  const v1Rows = v1
    .prepare(
      `SELECT id, room_id, sender, sender_type, content, message_type, file_meta, created_at
         FROM chat_messages`,
    )
    .all() as V1Message[];

  if (dryRun) {
    const files = v1Rows.filter((r) => r.message_type === 'file').length;
    console.log(`  [dry] would copy ${v1Rows.length} messages (${files} file refs)`);
    return { inserted: 0, skipped: 0, files };
  }

  const insert = getDb().prepare(
    `INSERT OR IGNORE INTO webchat_messages
       (id, room_id, sender, sender_type, content, message_type, file_meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  let skipped = 0;
  let files = 0;
  const tx = getDb().transaction((rows: V1Message[]) => {
    for (const r of rows) {
      const result = insert.run(
        r.id,
        r.room_id,
        r.sender,
        r.sender_type,
        r.content,
        r.message_type,
        r.file_meta,
        r.created_at,
      );
      if (result.changes > 0) {
        inserted++;
        if (r.message_type === 'file') files++;
      } else {
        skipped++;
      }
    }
  });
  tx(v1Rows);
  return { inserted, skipped, files };
}

function copyPushSubs(
  v1: Database.Database,
  ownerUserId: string,
  dryRun: boolean,
): { inserted: number; skipped: number } {
  const rows = v1
    .prepare(`SELECT endpoint, identity, keys_json, created_at FROM push_subscriptions`)
    .all() as V1PushSub[];
  if (rows.length === 0) return { inserted: 0, skipped: 0 };

  // Remap v1 identities (email or freeform) to the v2 owner. The webchat PWA
  // will re-subscribe on next load anyway, but keeping the row means existing
  // installs of the PWA see notifications without an explicit re-grant.
  if (dryRun) {
    console.log(`  [dry] would migrate ${rows.length} push subs to identity=${ownerUserId}`);
    return { inserted: 0, skipped: 0 };
  }

  const insert = getDb().prepare(
    `INSERT OR IGNORE INTO webchat_push_subscriptions (endpoint, identity, keys_json, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  let inserted = 0;
  let skipped = 0;
  for (const r of rows) {
    const result = insert.run(r.endpoint, ownerUserId, r.keys_json, r.created_at);
    if (result.changes > 0) inserted++;
    else skipped++;
  }
  return { inserted, skipped };
}

function ensureOllamaModel(endpoint: string, modelId: string, dryRun: boolean): string | null {
  const existing = listWebchatModels().find((m) => m.kind === 'ollama' && m.endpoint === endpoint && m.model_id === modelId);
  if (existing) {
    console.log(`  ollama model exists: ${existing.id} (${existing.name})`);
    return existing.id;
  }
  const id = randomUUID();
  if (dryRun) {
    console.log(`  [dry] create ollama model ${modelId} @ ${endpoint}`);
    return id;
  }
  createWebchatModel({
    id,
    name: `ollama:${modelId}`,
    kind: 'ollama',
    endpoint,
    model_id: modelId,
    credential_ref: null,
    created_at: Date.now(),
  });
  console.log(`  created ollama model: ${id} (${modelId} @ ${endpoint})`);
  return id;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.from)) {
    console.error(`v1 install path not found: ${args.from}`);
    process.exit(2);
  }
  const v1ChatDb = path.join(args.from, 'data', 'chat.sqlite');
  const v1StoreDb = path.join(args.from, 'store', 'messages.db');

  console.log(`source: ${args.from}`);
  console.log(`target: ${path.join(DATA_DIR, 'v2.db')}`);
  if (args.dryRun) console.log('mode:   DRY RUN (no writes)');
  console.log('');

  const v1Chat = openV1(v1ChatDb);
  const v1Store = openV1(v1StoreDb);

  initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(getDb());

  const owner = resolveOwner(args.owner);
  console.log(`owner: ${owner}`);
  console.log('');

  const rooms = v1Chat.prepare(`SELECT id, name, created_at FROM chat_rooms`).all() as V1Room[];
  const registered = v1Store
    .prepare(`SELECT jid, name, folder FROM registered_groups`)
    .all() as V1RegisteredGroup[];
  const folderByJid = new Map(registered.map((r) => [r.jid, r.folder]));

  console.log(`found ${rooms.length} rooms / ${registered.length} registered groups`);
  console.log('');

  const defaultInstructions = readDefaultInstructions(args.from);
  const now = new Date().toISOString();
  const agentIds: string[] = [];

  for (const room of rooms) {
    console.log(`room: ${room.name} (${room.id})`);
    const folder = folderByJid.get(`chat:${room.id}`) ?? `local_${room.id}`;
    const agId = ensureAgentGroup(folder, room.name, now, args.from, defaultInstructions, args.dryRun);
    const mgId = ensureMessagingGroup(room.id, room.name, room.created_at, args.dryRun);
    ensureWiring(mgId, agId, now, args.dryRun);
    ensureMembership(owner, agId, now, args.dryRun);
    agentIds.push(agId);
    console.log('');
  }

  // Optional: register Ollama model and assign to every new agent.
  if (args.ollamaEndpoint && args.ollamaModel) {
    console.log('ollama model:');
    const modelId = ensureOllamaModel(args.ollamaEndpoint, args.ollamaModel, args.dryRun);
    if (modelId && !args.dryRun) {
      for (const agId of agentIds) {
        assignModelToAgent(agId, modelId);
      }
      console.log(`  assigned to ${agentIds.length} agent(s)`);
    }
    console.log('');
  }

  // Messages.
  if (!args.noMessages) {
    console.log('messages:');
    const { inserted, skipped, files } = copyMessages(v1Chat, args.dryRun);
    console.log(`  inserted=${inserted} skipped=${skipped} (file refs preserved: ${files})`);
    console.log('');
  }

  // Push subscriptions.
  if (!args.noPush) {
    console.log('push subscriptions:');
    const { inserted, skipped } = copyPushSubs(v1Chat, owner, args.dryRun);
    console.log(`  inserted=${inserted} skipped=${skipped}`);
    console.log('');
  }

  v1Chat.close();
  v1Store.close();

  console.log('done.');
  if (args.dryRun) {
    console.log('(dry run — no rows written)');
  } else {
    console.log('');
    console.log('Next: load the webchat UI; rooms and history should appear.');
    console.log('Note: v1 file uploads are not copied — file messages render as');
    console.log('history entries but their URLs will 404 unless you also copy');
    console.log(`${args.from}/groups/<folder>/uploads → groups/<folder>/uploads`);
    console.log('and update the file_meta URLs to v2 paths.');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
