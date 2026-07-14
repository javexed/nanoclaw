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
    // `instance` (NOT NULL) is added by upstream migration 016, which precedes
    // this one in production order. Stay robust if it isn't present yet (e.g. a
    // test that builds a baseline excluding 016): include the column only when
    // it exists — a later 016 backfills it to channel_type ('webchat').
    const hasInstance = (db.prepare("PRAGMA table_info('messaging_groups')").all() as Array<{ name: string }>).some(
      (c) => c.name === 'instance',
    );
    const insertMg = db.prepare(
      hasInstance
        ? `INSERT INTO messaging_groups (id, channel_type, instance, platform_id, name, is_group, unknown_sender_policy, created_at)
           VALUES (?, 'webchat', 'webchat', ?, ?, 1, 'public', ?)`
        : `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
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
 * Per-room engagement-default setting.
 *
 * Two values:
 *   'broadcast'   — legacy default. When no prime is set, every wiring's
 *                   engage_pattern collapses to '.', i.e. every agent
 *                   responds to every message. Useful for single-agent
 *                   rooms; chaotic for many-agent shared rooms.
 *   'mention-only' — when no prime is set, every wiring is rewritten to
 *                   `\B@<folder>\b`. Unaddressed messages fall through
 *                   to nobody — the room is silent unless you @-mention
 *                   someone. Combine with prime=NULL for a "trading
 *                   floor" room with no fallback agent.
 *
 * When a prime IS set, the prime-mode rewrite logic in `recomputeEngagePatterns`
 * takes over and engage_default is ignored. This setting only affects the
 * no-prime branch.
 *
 * `room_id` is the messaging_groups.platform_id (same convention as
 * webchat_room_primes — no FK so the room-delete path can cascade in JS).
 */
export const moduleWebchatRoomSettings: Migration = {
  version: 105,
  name: 'webchat-room-settings',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_room_settings (
        room_id        TEXT PRIMARY KEY,
        engage_default TEXT NOT NULL DEFAULT 'broadcast',
        updated_at     INTEGER NOT NULL
      );
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

/**
 * Per-user room archive state.
 *
 * "Archived" is purely a sidebar-presentation hint — the room still routes
 * messages normally and shows up in unread counts. Each user controls their
 * own archive set; archiving a room only affects the archiving user's view.
 *
 * `room_id` is `messaging_groups.platform_id`. No FK (matches the
 * webchat_room_primes / webchat_messages convention) so cascade-on-delete
 * is handled in application code (deleteWebchatRoom).
 *
 * `user_id` is the trusted webchat userId (`webchat:<scheme>:<id>`),
 * established at auth time — same identifier used everywhere else
 * webchat does per-user state (push subscriptions, role grants).
 */
export const moduleWebchatUserArchives: Migration = {
  version: 105,
  name: 'webchat-user-archives',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_user_room_archives (
        user_id     TEXT NOT NULL,
        room_id     TEXT NOT NULL,
        archived_at TEXT NOT NULL,
        PRIMARY KEY (user_id, room_id)
      );
      CREATE INDEX IF NOT EXISTS idx_webchat_user_archives_user
        ON webchat_user_room_archives(user_id);
    `);
  },
};

/**
 * Split the per-user "archive" concept into two:
 *
 *   - `webchat_room_archives` — global archive flag per room, settable by
 *     owners + admins. Indicates a room is closed-to-active-work; appears
 *     in a collapsed "Archived" section in everyone's sidebar but still
 *     routes messages normally (archive is presentation, not silencing).
 *
 *   - `webchat_user_room_hides` — renamed from `webchat_user_room_archives`.
 *     Per-user sidebar preference. Hides a room from one user's view only,
 *     no effect on anyone else.
 *
 * Migration steps (atomic — runs in a single transaction per the migrate
 * loop):
 *
 *   1. Create the new global-archive table.
 *   2. Promote existing per-user "archive" rows → one global-archive row per
 *      room (earliest archived_at wins; archived_by null because they came
 *      from possibly multiple users and the legacy table didn't track it).
 *   3. ALTER TABLE rename `webchat_user_room_archives` → `webchat_user_room_hides`.
 *      SQLite preserves indexes through ALTER TABLE RENAME; we drop+recreate
 *      the index under the new name for clarity, so DB inspection makes
 *      sense.
 *   4. Truncate the new `webchat_user_room_hides` table — the migrated rows
 *      represented archive intent, not hide intent, and were promoted to
 *      globals in step 2. Hides starts empty for everyone.
 *
 * Forward-only: there is no down-migration. Reverting would conflate
 * promoted-global-archives with original-per-user-archives, which can't be
 * separated cleanly.
 */
export const moduleWebchatArchiveSplit: Migration = {
  version: 106,
  name: 'webchat-archive-split',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_room_archives (
        room_id      TEXT PRIMARY KEY,
        archived_at  TEXT NOT NULL,
        archived_by  TEXT
      );
    `);

    // Step 2 + 3 + 4 depend on the legacy table existing. On fresh installs
    // it exists because version 105 ran first (registered earlier in the
    // migrations array). Guard defensively in case of reordering.
    const hasLegacy = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='webchat_user_room_archives'`)
      .get();
    if (!hasLegacy) return;

    db.exec(`
      INSERT OR IGNORE INTO webchat_room_archives (room_id, archived_at, archived_by)
        SELECT room_id, MIN(archived_at), NULL
          FROM webchat_user_room_archives
         GROUP BY room_id;

      ALTER TABLE webchat_user_room_archives RENAME TO webchat_user_room_hides;
      DROP INDEX IF EXISTS idx_webchat_user_archives_user;
      CREATE INDEX IF NOT EXISTS idx_webchat_user_hides_user
        ON webchat_user_room_hides(user_id);

      DELETE FROM webchat_user_room_hides;
    `);
  },
};

/**
 * Relax the primary key on `webchat_approvals_index` from `approval_id` to
 * `(approval_id, platform_id)` so one approval can be indexed against multiple
 * approver inboxes. Required for the fan-out delivery path in
 * `requestApproval` — every reachable approver gets a card with the same
 * approval_id, and the index needs one row per recipient inbox.
 *
 * SQLite can't redefine a primary key in place, so this rebuilds the table.
 * Existing rows are preserved; the platform_id lookup index is recreated.
 */
export const moduleWebchatApprovalsIndexFanout: Migration = {
  version: 107,
  name: 'webchat-approvals-index-fanout',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE webchat_approvals_index_new (
        approval_id   TEXT NOT NULL,
        platform_id   TEXT NOT NULL,
        recorded_at   INTEGER NOT NULL,
        PRIMARY KEY (approval_id, platform_id)
      );
      INSERT INTO webchat_approvals_index_new (approval_id, platform_id, recorded_at)
        SELECT approval_id, platform_id, recorded_at FROM webchat_approvals_index;
      DROP TABLE webchat_approvals_index;
      ALTER TABLE webchat_approvals_index_new RENAME TO webchat_approvals_index;
      CREATE INDEX IF NOT EXISTS idx_webchat_approvals_platform
        ON webchat_approvals_index(platform_id);
    `);
  },
};

/**
 * Full-text search over message content (FTS5). An external-content virtual
 * table mirrors webchat_messages.content (no duplicate storage), kept in sync
 * by INSERT/DELETE/UPDATE triggers. Existing rows are backfilled on first run.
 * Powers GET /api/search. FTS5 is compiled into the bundled SQLite.
 */
export const moduleWebchatMessageFts: Migration = {
  version: 110,
  name: 'webchat-message-fts',
  up(db: Database.Database) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS webchat_messages_fts
        USING fts5(content, content='webchat_messages', content_rowid='rowid');

      CREATE TRIGGER IF NOT EXISTS webchat_messages_fts_ai AFTER INSERT ON webchat_messages BEGIN
        INSERT INTO webchat_messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS webchat_messages_fts_ad AFTER DELETE ON webchat_messages BEGIN
        INSERT INTO webchat_messages_fts(webchat_messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS webchat_messages_fts_au AFTER UPDATE ON webchat_messages BEGIN
        INSERT INTO webchat_messages_fts(webchat_messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO webchat_messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      INSERT INTO webchat_messages_fts(rowid, content)
        SELECT rowid, content FROM webchat_messages;
    `);
  },
};

/**
 * Agent lifecycle status: active | paused | archived. Delivered as a webchat
 * module migration (webchat is the consumer — the Agents UI surfaces/sets it;
 * the router gates engagement on it). Adds a NOT NULL column defaulting to
 * 'active', so every existing agent keeps responding. Writes are validated in
 * setAgentStatus (src/db/agent-groups.ts) — plain TEXT, no CHECK, matching the
 * rest of the schema.
 */
export const moduleWebchatAgentStatus: Migration = {
  version: 111,
  name: 'agent-status',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE agent_groups ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
    `);
  },
};

/**
 * Per-user "last read" marker so unread state survives an away-and-return.
 *
 * Before this table unread was a purely client-side, in-memory Set: it was
 * populated only by live `{type:'unread'}` WS pushes while a tab was open, so
 * messages that arrived while the user was away left no trace the UI could
 * reconstruct on reconnect (the rooms payload carried no unread metadata).
 *
 * `last_read_at` is the high-water mark of message `created_at` the user has
 * seen in a room. A room is unread for the user when the newest message in it
 * is newer than this marker (or there's no row yet and the room has messages).
 * Advanced on join, on receiving a message in the open room, and on the user's
 * own sends. Keyed on the trusted webchat `user_id` (same identifier as
 * webchat_user_room_hides / push subscriptions), so the marker — and therefore
 * the unread badge — is shared across all of that user's devices.
 *
 * `room_id` is `messaging_groups.platform_id` (no FK, matching the rest of the
 * webchat tables; deleteWebchatRoom clears rows in app code).
 */
export const moduleWebchatRoomReads: Migration = {
  version: 112,
  name: 'webchat-room-reads',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_room_reads (
        user_id      TEXT NOT NULL,
        room_id      TEXT NOT NULL,
        last_read_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, room_id)
      );
      CREATE INDEX IF NOT EXISTS idx_webchat_room_reads_user
        ON webchat_room_reads(user_id);
    `);
  },
};

/**
 * UserCreds: per-room credential mode.
 *   disabled (default) — one shared session/agent; no per-member sessions.
 *   optional           — members with a connected key get their own per-member
 *                        session billed to them; others use the shared agent.
 *   required           — every member must connect their own key.
 * Secure-by-default: rooms start 'disabled' until an admin opts in.
 */
export const moduleWebchatRoomCredentialMode: Migration = {
  version: 108,
  name: 'webchat-room-credential-mode',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE webchat_room_settings ADD COLUMN credential_mode TEXT NOT NULL DEFAULT 'disabled';
    `);
  },
};

/**
 * UserCreds OAuth: per-room toggle allowing members to connect a Claude *subscription*
 * (OAuth) token, orthogonal to `credential_mode` (which governs API-key UserCreds).
 * Off by default — a room never accepts OAuth tokens until an owner/admin opts
 * in. See docs/webchat/user-credentials-oauth.md.
 */
export const moduleWebchatRoomOauthAllowed: Migration = {
  version: 109,
  name: 'webchat-room-oauth-allowed',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE webchat_room_settings ADD COLUMN oauth_allowed INTEGER NOT NULL DEFAULT 0;
    `);
  },
};

/**
 * Per-user @-mention handle. `user_id` is the canonical webchat user id
 * (e.g. `webchat:tailscale:foo@bar.com`); `handle` is the lowercase slug others
 * type to @-mention them (`@alice`), UNIQUE so a handle resolves to one user.
 * Defaults to a slug of the display name on first connect (see ensureWebchatUserHandle).
 */
export const moduleWebchatUserHandles: Migration = {
  version: 113,
  name: 'webchat-user-handles',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_user_handles (
        user_id    TEXT PRIMARY KEY,
        handle     TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_webchat_user_handles_handle
        ON webchat_user_handles(handle);
    `);
  },
};

/**
 * Per-user room pins. The sidebar sorts rooms by recent activity (newest
 * message first); pinned rooms are lifted into a sticky group at the top, above
 * a divider, so the ones you care about don't drift down as other rooms get
 * traffic. Each user controls their own pins — pinning only affects their view.
 *
 * Keyed on the trusted webchat `user_id` (same as webchat_room_reads /
 * webchat_user_room_hides), so a pin follows the user across all their devices.
 * `room_id` is `messaging_groups.platform_id` (no FK; deleteWebchatRoom clears
 * rows in app code).
 */
export const moduleWebchatRoomPins: Migration = {
  version: 114,
  name: 'webchat-room-pins',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_room_pins (
        user_id   TEXT NOT NULL,
        room_id   TEXT NOT NULL,
        pinned_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, room_id)
      );
      CREATE INDEX IF NOT EXISTS idx_webchat_room_pins_user
        ON webchat_room_pins(user_id);
    `);
  },
};

/**
 * Workspace-wide credentials policy + per-room mode inheritance.
 *
 * `webchat_settings` is a singleton (id=1) holding which user-credential TYPES
 * the workspace accepts ({API key | OAuth} × {Claude | Codex}) and the default
 * room mode. Types are global so they're configured once, not per room. The
 * per-room control becomes an OVERRIDE: `credential_mode_override` is nullable —
 * NULL means "inherit the global default", a value means this room overrides it.
 * New/untouched rooms (NULL) inherit automatically.
 *
 * Migration preserves current behavior: any room previously set to optional/
 * required keeps that as an explicit override, and `allow_claude_oauth` seeds to
 * 1 if any room had the old per-room `oauth_allowed` on (so existing OAuth rooms
 * keep working). Anthropic keys default on; Codex types default off (and are
 * inert until the Codex provider is installed).
 */
export const moduleWebchatCredentialsConfig: Migration = {
  version: 115,
  name: 'webchat-credentials-config',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_settings (
        id                      INTEGER PRIMARY KEY CHECK (id = 1),
        default_credential_mode TEXT    NOT NULL DEFAULT 'disabled',
        allow_anthropic_key     INTEGER NOT NULL DEFAULT 1,
        allow_claude_oauth      INTEGER NOT NULL DEFAULT 0,
        allow_openai_key        INTEGER NOT NULL DEFAULT 0,
        allow_codex_oauth       INTEGER NOT NULL DEFAULT 0,
        updated_at              INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO webchat_settings (id, allow_claude_oauth, updated_at)
        VALUES (
          1,
          (SELECT CASE WHEN EXISTS (SELECT 1 FROM webchat_room_settings WHERE oauth_allowed = 1) THEN 1 ELSE 0 END),
          0
        );
      ALTER TABLE webchat_room_settings ADD COLUMN credential_mode_override TEXT;
      UPDATE webchat_room_settings
         SET credential_mode_override = credential_mode
       WHERE credential_mode IN ('optional', 'required');
    `);
  },
};

/**
 * Per-room threads. A webchat "thread" maps to an agent session via `thread_id`
 * (the session key), so each thread is an isolated conversation. See
 * docs/webchat/threads.md.
 *
 *   - `webchat_threads` is the thread registry; `thread_id` becomes
 *     `session.thread_id` for that room. Ids: 'main' (implicit default),
 *     'agent:<folder>' (per-agent lane), or a uuid (manual topic thread).
 *   - `webchat_messages.thread_id` partitions history per thread; the column
 *     default 'main' migrates all existing rows into each room's main thread
 *     with no data loss and no visible change.
 *   - `webchat_thread_reads` widens the per-room read marker to per-thread;
 *     existing `webchat_room_reads` rows seed the 'main' thread marker.
 */
export const moduleWebchatThreads: Migration = {
  version: 116,
  name: 'webchat-threads',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_threads (
        room_id    TEXT NOT NULL,
        thread_id  TEXT NOT NULL,
        title      TEXT NOT NULL,
        kind       TEXT NOT NULL DEFAULT 'topic',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (room_id, thread_id)
      );
      CREATE TABLE IF NOT EXISTS webchat_thread_reads (
        user_id      TEXT NOT NULL,
        room_id      TEXT NOT NULL,
        thread_id    TEXT NOT NULL,
        last_read_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, room_id, thread_id)
      );
    `);
    // ADD COLUMN is not idempotent — guard it so a re-run (or a partial prior
    // apply) doesn't throw "duplicate column name".
    const hasThreadCol = (db.prepare("PRAGMA table_info('webchat_messages')").all() as Array<{ name: string }>).some(
      (c) => c.name === 'thread_id',
    );
    if (!hasThreadCol) {
      db.exec(`ALTER TABLE webchat_messages ADD COLUMN thread_id TEXT NOT NULL DEFAULT 'main'`);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_webchat_messages_thread
        ON webchat_messages(room_id, thread_id, created_at);
    `);
    // Seed per-thread read markers from existing per-room markers (→ 'main').
    db.exec(`
      INSERT OR IGNORE INTO webchat_thread_reads (user_id, room_id, thread_id, last_read_at)
        SELECT user_id, room_id, 'main', last_read_at FROM webchat_room_reads;
    `);
    // Per-room auto-thread setting (confirm-first per-agent lanes). NULL = unset
    // → effective default is "on for multi-agent rooms" (computed at read).
    const hasAutoThread = (
      db.prepare("PRAGMA table_info('webchat_room_settings')").all() as Array<{ name: string }>
    ).some((c) => c.name === 'auto_thread');
    if (!hasAutoThread) {
      db.exec(`ALTER TABLE webchat_room_settings ADD COLUMN auto_thread INTEGER`);
    }
  },
};

/**
 * Per-thread "engaged agents" set. A row means agent_group_id is engaged in
 * (room_id, thread_id): it receives every message in that thread and is expected
 * to reply when addressed. Never written for the 'main' thread (the regular chat
 * stays mention-only). See docs/webchat/thread-engaged-agents.md.
 */
export const moduleWebchatThreadEngaged: Migration = {
  version: 117,
  name: 'webchat-thread-engaged',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_thread_engaged (
        room_id        TEXT NOT NULL,
        thread_id      TEXT NOT NULL,
        agent_group_id TEXT NOT NULL,
        engaged_at     INTEGER NOT NULL,
        PRIMARY KEY (room_id, thread_id, agent_group_id)
      );
      CREATE INDEX IF NOT EXISTS idx_webchat_engaged_thread
        ON webchat_thread_engaged(room_id, thread_id);
    `);
  },
};

/**
 * Manual ordering for pinned rooms. Adds a per-user `position` to
 * webchat_room_pins so the operator can drag pinned rooms into a fixed order
 * (previously the pinned group auto-sorted by recent activity). Existing pins
 * are backfilled 0-indexed by pinned_at (oldest pin at the top), a stable
 * starting order; the room_id tiebreaker keeps it deterministic.
 */
export const moduleWebchatRoomPinOrder: Migration = {
  version: 116,
  name: 'webchat-room-pin-order',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE webchat_room_pins ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
      UPDATE webchat_room_pins
         SET position = (
           SELECT COUNT(*) FROM webchat_room_pins p2
            WHERE p2.user_id = webchat_room_pins.user_id
              AND (p2.pinned_at < webchat_room_pins.pinned_at
                   OR (p2.pinned_at = webchat_room_pins.pinned_at
                       AND p2.room_id < webchat_room_pins.room_id))
         );
    `);
  },
};

/**
 * Thread context sync (pull/push). Adds:
 *   - webchat_messages.origin — NULL = native message; 'pulled' = copied in from
 *     main; 'pushed' = copied up from a thread. Lets push select only native
 *     thread messages (skip the pulled-in prefix) and the client mark imports.
 *   - webchat_thread_sync — per-thread high-water marks so pull/push are
 *     incremental (each sync appends only the source delta; no duplicates).
 * See docs/webchat/thread-context-sync.md.
 */
export const moduleWebchatThreadContextSync: Migration = {
  version: 118,
  name: 'webchat-thread-context-sync',
  up(db: Database.Database) {
    // ADD COLUMN isn't idempotent — guard against a partial prior apply.
    const hasOrigin = (db.prepare("PRAGMA table_info('webchat_messages')").all() as Array<{ name: string }>).some(
      (c) => c.name === 'origin',
    );
    if (!hasOrigin) {
      db.exec(`ALTER TABLE webchat_messages ADD COLUMN origin TEXT`);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_thread_sync (
        room_id            TEXT NOT NULL,
        thread_id          TEXT NOT NULL,
        last_pulled_src_ts INTEGER NOT NULL DEFAULT 0,
        last_pushed_src_ts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (room_id, thread_id)
      );
    `);
  },
};

/**
 * MCP server registry — mirrors webchat_models/webchat_agent_models (§103
 * above), but the assignment is many-to-many (an agent can have several MCP
 * servers; the same server can be wired to several agents), unlike a model's
 * 1:1 assignment.
 *
 * `webchat_mcp_servers` is the registry. `transport` selects the shape:
 *   - 'stdio': command/args/env — a subprocess spawned inside the agent's
 *     container. Defined once here so the same server can be attached to
 *     multiple agents without re-entering it.
 *   - 'sse' | 'http': url/headers — a server reached over the network
 *     (e.g. a tool server on another machine). These are the transports the
 *     host-side probe (POST /api/mcp-servers/probe) can verify before save.
 * `args`/`env`/`headers` are stored as JSON text (sqlite has no array/object
 * column type), matching the mcp_servers JSON column on container_configs.
 *
 * `webchat_agent_mcp_servers` is the assignment join. PK on
 * (agent_group_id, mcp_server_id) — many-to-many, no FK (mirrors
 * webchat_agent_models: the delete-server handler cascades in JS after
 * surfacing the impact list to the operator).
 *
 * Assign/unassign is an INCREMENTAL upsert/delete against a single key —
 * container_configs.mcp_servers[server.name] — not a wholesale recompute.
 * That matters because `ncl groups config add-mcp-server` writes into the
 * same JSON column directly (a separate, still-supported entry point); a
 * full recompute-from-registry on every assignment change would silently
 * wipe any ncl-added server with a name outside the registry. Incremental
 * writes only ever touch the one key they own.
 */
export const moduleWebchatMcpServers: Migration = {
  version: 119,
  name: 'webchat-mcp-servers',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_mcp_servers (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        transport     TEXT NOT NULL,
        command       TEXT,
        args          TEXT,
        env           TEXT,
        url           TEXT,
        headers       TEXT,
        instructions  TEXT,
        created_at    INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webchat_agent_mcp_servers (
        agent_group_id  TEXT NOT NULL,
        mcp_server_id   TEXT NOT NULL,
        assigned_at     INTEGER NOT NULL,
        PRIMARY KEY (agent_group_id, mcp_server_id)
      );
      CREATE INDEX IF NOT EXISTS idx_webchat_agent_mcp_servers_server
        ON webchat_agent_mcp_servers(mcp_server_id);
    `);
  },
};

/**
 * First-run setup-wizard state. A single boolean on the `webchat_settings`
 * singleton (id=1): 0 = onboarding not finished (the owner sees the auto-opening
 * wizard on first login), 1 = finished/dismissed. Owner-only to flip; re-openable
 * from Settings regardless. Kept on the existing settings singleton rather than a
 * new table — it's one workspace-wide flag.
 */
export const moduleWebchatOnboarding: Migration = {
  version: 123,
  name: 'webchat-onboarding',
  up(db: Database.Database) {
    // ADD COLUMN isn't idempotent — guard against a re-run / partial prior apply.
    const hasCol = (db.prepare("PRAGMA table_info('webchat_settings')").all() as Array<{ name: string }>).some(
      (c) => c.name === 'onboarding_complete',
    );
    if (!hasCol) {
      db.exec(`ALTER TABLE webchat_settings ADD COLUMN onboarding_complete INTEGER NOT NULL DEFAULT 0`);
    }
  },
};

/**
 * Voice-dictation transcript cleanup — which roster model (webchat_models.id)
 * tidies raw dictation text. NULL = no cleanup (raw transcript). Lives on the
 * webchat_settings singleton: one workspace-wide choice, owner-set.
 */
export const moduleWebchatStt: Migration = {
  version: 124,
  name: 'webchat-stt',
  up(db: Database.Database) {
    const hasCol = (db.prepare("PRAGMA table_info('webchat_settings')").all() as Array<{ name: string }>).some(
      (c) => c.name === 'stt_cleanup_model_id',
    );
    if (!hasCol) {
      db.exec(`ALTER TABLE webchat_settings ADD COLUMN stt_cleanup_model_id TEXT`);
    }
  },
};

/**
 * Bearer-token opt-out. The provisioner seeds WEBCHAT_TOKEN so a LAN-exposed
 * install isn't open before the owner claims it, but a shared secret is weaker
 * than identity auth. Once Tailscale or a trusted-proxy / SSO (EntraID) method
 * is live, the owner can retire the bearer token from Settings: this flag makes
 * auth.ts ignore WEBCHAT_TOKEN (the value stays in .env but no longer
 * authenticates). Only offered when an alternative method is active, so
 * disabling it can never leave the server with no way to authenticate anyone.
 * 0 = bearer honored (default), 1 = bearer inert.
 */
export const moduleWebchatBearerAuth: Migration = {
  version: 130,
  name: 'webchat-bearer-auth',
  up(db: Database.Database) {
    const hasCol = (db.prepare("PRAGMA table_info('webchat_settings')").all() as Array<{ name: string }>).some(
      (c) => c.name === 'bearer_token_disabled',
    );
    if (!hasCol) {
      db.exec(`ALTER TABLE webchat_settings ADD COLUMN bearer_token_disabled INTEGER NOT NULL DEFAULT 0`);
    }
  },
};

/**
 * MCP + skills-marketplace opt-out. Both are code-execution surfaces (MCP wires
 * arbitrary servers; the skills marketplace imports code from git). On by
 * default (recommended), but an owner can disable them from the setup wizard /
 * Settings for a locked-down deployment — which hides the MCP + Skills tabs AND
 * makes the server 403 their endpoints (DOM + server, per the admin-surface
 * rule). 0 = enabled (default), 1 = disabled.
 */
export const moduleWebchatMarketplaceToggle: Migration = {
  version: 131,
  name: 'webchat-marketplace-toggle',
  up(db: Database.Database) {
    const hasCol = (db.prepare("PRAGMA table_info('webchat_settings')").all() as Array<{ name: string }>).some(
      (c) => c.name === 'marketplace_disabled',
    );
    if (!hasCol) {
      db.exec(`ALTER TABLE webchat_settings ADD COLUMN marketplace_disabled INTEGER NOT NULL DEFAULT 0`);
    }
  },
};

/**
 * One-shot "first Tailscale login becomes owner". The bearer bootstrap identity
 * grabs the owner slot during the wizard, so a later Tailscale login would land
 * as a non-owner. When the operator opts in (wizard: "I'll use Tailscale"), this
 * flag makes auth.ts promote the FIRST tailscale identity to owner, then clears
 * itself. 0 = off (default), 1 = armed.
 */
export const moduleWebchatTailscaleOwner: Migration = {
  version: 132,
  name: 'webchat-tailscale-owner',
  up(db: Database.Database) {
    const hasCol = (db.prepare("PRAGMA table_info('webchat_settings')").all() as Array<{ name: string }>).some(
      (c) => c.name === 'promote_first_tailscale_owner',
    );
    if (!hasCol) {
      db.exec(`ALTER TABLE webchat_settings ADD COLUMN promote_first_tailscale_owner INTEGER NOT NULL DEFAULT 0`);
    }
  },
};

/**
 * Workspace DEFAULT model — the roster model (webchat_models.id, ollama kind)
 * that any claude-family agent WITHOUT its own assigned model falls back to.
 * The model analogue of the workspace default credential: the wizard's
 * "default engine = Ollama" writes this, and every unassigned agent inherits
 * it at spawn. NULL = no fallback (unassigned agents use the workspace
 * Anthropic credential as before).
 */
export const moduleWebchatDefaultModel: Migration = {
  version: 125,
  name: 'webchat-default-model',
  up(db: Database.Database) {
    const hasCol = (db.prepare("PRAGMA table_info('webchat_settings')").all() as Array<{ name: string }>).some(
      (c) => c.name === 'default_model_id',
    );
    if (!hasCol) {
      db.exec(`ALTER TABLE webchat_settings ADD COLUMN default_model_id TEXT`);
    }
  },
};

/**
 * Editable registry of well-known skill collections (the Skills tab's catalog
 * sources). Seeded with the two curated defaults; global admins manage the
 * list from Settings. Each row is a GitHub repo location with one skill
 * folder per entry under `dir`.
 */
export const moduleWebchatSkillSources: Migration = {
  version: 120,
  name: 'webchat-skill-sources',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webchat_skill_sources (
        id         TEXT PRIMARY KEY,
        label      TEXT NOT NULL,
        owner      TEXT NOT NULL,
        repo       TEXT NOT NULL,
        branch     TEXT NOT NULL,
        dir        TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    const now = Date.now();
    const seed = db.prepare(
      `INSERT OR IGNORE INTO webchat_skill_sources (id, label, owner, repo, branch, dir, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    seed.run('anthropic', 'Anthropic (official)', 'anthropics', 'skills', 'main', 'skills', now);
    seed.run('superpowers', 'Superpowers (community)', 'obra', 'superpowers', 'main', 'skills', now);
  },
};

/**
 * Two-tier trust for skill collections: `official` marks curated, first-party
 * sources (Anthropic) that get a direct-add UX; everything else — Superpowers
 * and any admin-added collection — is community (review link + confirm gate).
 */
export const moduleWebchatSkillSourcesOfficial: Migration = {
  version: 121,
  name: 'webchat-skill-sources-official',
  up(db: Database.Database) {
    const hasCol = (db.prepare("PRAGMA table_info('webchat_skill_sources')").all() as Array<{ name: string }>).some(
      (c) => c.name === 'official',
    );
    if (!hasCol) db.exec('ALTER TABLE webchat_skill_sources ADD COLUMN official INTEGER NOT NULL DEFAULT 0');
    db.prepare("UPDATE webchat_skill_sources SET official = 1 WHERE id = 'anthropic'").run();
  },
};

// Records which CODE-WIRED built-in sources (the awesomeskill.ai marketplace)
// an owner has switched off, so they can be removed from the pool like any GitHub
// collection. Absence = enabled; a row = disabled.
export const moduleWebchatDisabledBuiltins: Migration = {
  version: 122,
  name: 'webchat-disabled-builtins',
  up(db: Database.Database) {
    db.exec('CREATE TABLE IF NOT EXISTS webchat_disabled_sources (id TEXT PRIMARY KEY)');
  },
};
