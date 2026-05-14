import { randomUUID } from 'crypto';

import type Database from 'better-sqlite3';

// `import type` keeps this a type-only edge so the trunk → skill →
// trunk-types cycle is erased at runtime; otherwise the cycle would
// load with `Migration` undefined for the brief window it imports back.
import type { Migration } from '../../db/migrations/index.js';

/**
 * Webchat module schema (initial).
 *
 * Tables:
 *   - webchat_rooms: chat room metadata (name, created_at). DEPRECATED — the
 *     `webchat-drop-rooms` migration removes this table and migrates rows
 *     into `messaging_groups WHERE channel_type='webchat'`. Kept here for
 *     installs that came before that migration; new installs land both
 *     migrations in the same run, so the table flickers in and out.
 *   - webchat_messages: per-room message log used by the PWA for history
 *     and replay. Distinct from inbound.db / outbound.db — the adapter
 *     mirrors agent traffic into this log so the PWA has a single view.
 *     `room_id` originally REFERENCED webchat_rooms with a cascade — the
 *     drop-rooms migration recreates this table without the FK so the
 *     `room_id` column is just `messaging_groups.platform_id` by convention.
 *   - webchat_push_subscriptions: Web Push endpoints keyed by user identity.
 */
export const moduleWebchat: Migration = {
  version: 100,
  name: 'webchat-initial',
  up(db: Database.Database) {
    // IF NOT EXISTS guards survive the install→remove→install cycle when the
    // user skipped the optional DROP TABLE block in REMOVE.md (which would
    // otherwise leave the tables behind without their schema_version row,
    // breaking re-install with "table already exists").
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_rooms (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webchat_messages (
        id            TEXT PRIMARY KEY,
        room_id       TEXT NOT NULL REFERENCES webchat_rooms(id) ON DELETE CASCADE,
        sender        TEXT NOT NULL,
        sender_type   TEXT NOT NULL DEFAULT 'user',
        content       TEXT NOT NULL,
        message_type  TEXT NOT NULL DEFAULT 'text',
        file_meta     TEXT,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_webchat_messages_room
        ON webchat_messages(room_id, created_at);

      CREATE TABLE IF NOT EXISTS webchat_push_subscriptions (
        endpoint    TEXT PRIMARY KEY,
        identity    TEXT NOT NULL,
        keys_json   TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_webchat_push_identity
        ON webchat_push_subscriptions(identity);
    `);
  },
};

/**
 * Drop the redundant `webchat_rooms` table. After this migration:
 *   - `messaging_groups WHERE channel_type='webchat'` is the single source
 *     of truth for "what rooms exist". `webchat_rooms.id` corresponds to
 *     `messaging_groups.platform_id`.
 *   - `webchat_messages.room_id` is a plain string (no FK) that holds the
 *     same `platform_id`. The cascade-on-room-delete behavior moves to
 *     application code (`deleteWebchatRoom` deletes messages explicitly).
 *
 * Migration steps:
 *   1. Backfill any `webchat_rooms` rows that don't already exist in
 *      `messaging_groups` (the install-time room was created before any
 *      agent was wired, so it could be missing).
 *   2. Recreate `webchat_messages` without the FK (SQLite can't drop FKs
 *      in place; we copy into a new table and rename).
 *   3. Drop `webchat_rooms`.
 */
export const moduleWebchatDropRooms: Migration = {
  version: 101,
  name: 'webchat-drop-rooms',
  up(db: Database.Database) {
    // Skip cleanly on installs that never created webchat_rooms (shouldn't
    // happen since webchat-initial runs first in the same migrate pass, but
    // defensive against future reordering).
    const hasRooms = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='webchat_rooms'`).get();
    if (!hasRooms) return;

    // 1. Backfill rooms that lack a messaging_groups row.
    const orphans = db
      .prepare(
        `SELECT wr.id, wr.name, wr.created_at FROM webchat_rooms wr
         WHERE NOT EXISTS (
           SELECT 1 FROM messaging_groups mg
           WHERE mg.channel_type='webchat' AND mg.platform_id=wr.id
         )`,
      )
      .all() as { id: string; name: string; created_at: number }[];
    const insertMg = db.prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, 'webchat', ?, ?, 1, 'public', ?)`,
    );
    for (const row of orphans) {
      insertMg.run(randomUUID(), row.id, row.name, new Date(row.created_at).toISOString());
    }

    // 2. Recreate webchat_messages without the FK to webchat_rooms.
    db.exec(`
      CREATE TABLE webchat_messages_new (
        id            TEXT PRIMARY KEY,
        room_id       TEXT NOT NULL,
        sender        TEXT NOT NULL,
        sender_type   TEXT NOT NULL DEFAULT 'user',
        content       TEXT NOT NULL,
        message_type  TEXT NOT NULL DEFAULT 'text',
        file_meta     TEXT,
        created_at    INTEGER NOT NULL
      );
      INSERT INTO webchat_messages_new
        (id, room_id, sender, sender_type, content, message_type, file_meta, created_at)
        SELECT id, room_id, sender, sender_type, content, message_type, file_meta, created_at
        FROM webchat_messages;
      DROP TABLE webchat_messages;
      ALTER TABLE webchat_messages_new RENAME TO webchat_messages;
      CREATE INDEX idx_webchat_messages_room
        ON webchat_messages(room_id, created_at);
    `);

    // 3. Drop the legacy table.
    db.exec(`DROP TABLE webchat_rooms;`);
  },
};

/**
 * Per-room "prime" agent designation.
 *
 * A room can opt-in to "prime" routing: one wired agent answers all messages,
 * unless the message @-mentions another wired agent (by their slug folder
 * name). This is implemented entirely by rewriting `messaging_group_agents.engage_pattern`
 * on every wiring change — no router code change needed. See `recomputeEngagePatterns`
 * in server.ts for the rewrite logic.
 *
 * `room_id` is the messaging_groups.platform_id (no FK because the FK
 * constraint would force us to mirror cascade-on-room-delete here too;
 * the deleteWebchatRoom path already cleans this table explicitly).
 */
export const moduleWebchatRoomPrimes: Migration = {
  version: 102,
  name: 'webchat-room-primes',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_room_primes (
        room_id        TEXT PRIMARY KEY,
        agent_group_id TEXT NOT NULL,
        created_at     INTEGER NOT NULL
      );
    `);
  },
};

/**
 * Models — registered LLM endpoints/configurations that the operator can
 * assign to agents.
 *
 * `webchat_models` is the registry. `kind` selects the implementation:
 *   - 'anthropic': use the operator's existing Anthropic credential
 *     (managed by OneCLI) but pin to a specific model_id.
 *   - 'ollama': route Anthropic SDK calls at a local Ollama endpoint
 *     (Ollama speaks the Anthropic API at <endpoint>/v1/messages).
 *   `endpoint` is required for ollama, ignored for anthropic.
 *   `credential_ref` is reserved for future kinds (openai-compatible) and
 *   points at a OneCLI secret name; null for the MVP kinds.
 *
 * `webchat_agent_models` records which model is assigned to which agent.
 * PK on agent_group_id keeps it 1:1 (one model per agent). No FK to
 * `webchat_models` so the delete-model handler can do
 * cascade-with-confirmation in JS — operator sees the impact list before
 * the assignments disappear.
 */
export const moduleWebchatModels: Migration = {
  version: 103,
  name: 'webchat-models',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_models (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        kind            TEXT NOT NULL,
        endpoint        TEXT,
        model_id        TEXT NOT NULL,
        credential_ref  TEXT,
        created_at      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webchat_agent_models (
        agent_group_id  TEXT PRIMARY KEY,
        model_id        TEXT NOT NULL,
        assigned_at     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_webchat_agent_models_model
        ON webchat_agent_models(model_id);
    `);
  },
};

/**
 * Skill-side index of webchat-bound approvals so the PWA can query
 * "which approvals are for this user?" without depending on a trunk-side
 * stamp on `pending_approvals.channel_type`/`platform_id` (those columns
 * exist on the trunk schema but trunk's `requestApproval` doesn't
 * populate them — so a query filtering on them returns nothing).
 *
 * Webchat populates this index inside its own `deliver()` whenever an
 * approval lands on a webchat approval-inbox. The PWA's
 * `/api/approvals/pending` query JOINs `pending_approvals` against this
 * index keyed on `approval_id`. No trunk modification required.
 *
 * Rows aren't pruned when an approval transitions out of 'pending' —
 * stale rows are filtered out by the JOIN's `pa.status = 'pending'`
 * predicate. A future cleanup job can reap them; for current install
 * sizes (dozens of approvals total in the lifetime of an install), the
 * cost is negligible.
 */
export const moduleWebchatApprovalsIndex: Migration = {
  version: 104,
  name: 'webchat-approvals-index',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_approvals_index (
        approval_id   TEXT PRIMARY KEY,
        platform_id   TEXT NOT NULL,
        recorded_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_webchat_approvals_platform
        ON webchat_approvals_index(platform_id);
    `);
  },
};
