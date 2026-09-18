/**
 * Web schema — consolidated migrations.
 *
 * An earlier, multi-user version of this web reached its schema through
 * many incremental migrations. This single-user build has no installed base
 * to migrate, so the FINAL shapes are declared here directly, in three
 * feature-scoped migrations. Rules carried over:
 *
 *   - Rooms are NOT a web table. A room IS its `messaging_groups` row
 *     (`channel_type = 'web'`, `platform_id` = room id) — one source of
 *     truth for the router and the UI alike. The overlay learned this the
 *     hard way (its `web-drop-rooms` migration).
 *   - `web_messages` mirrors the conversation for the PWA's history
 *     view; routing/delivery still flows through the per-session inbound/
 *     outbound DBs like every other channel.
 *   - Timestamps in web tables are INTEGER ms epochs (the UI sorts and
 *     pages on them); this deliberately differs from the ISO-string TEXT
 *     convention of the core tables and is contained to `web_*`.
 *
 * Single-user simplifications vs the overlay: no per-user reads/pins/
 * archives/handles tables, no threads, no FTS, no push subscriptions, and
 * `web_settings` is one row of install-level flags rather than a
 * credential-policy matrix.
 */
import type Database from 'better-sqlite3';

import { registerMigration, type Migration, type ModuleMigration } from '../../db/migrations/index.js';

/** Chat surface: message log, room→agent wiring, install settings. */
export const moduleWebCore: Migration = {
  version: 1,
  name: 'module:web:core',
  sqliteOnly: true,
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE web_messages (
        id            TEXT PRIMARY KEY,
        room_id       TEXT NOT NULL,
        sender        TEXT NOT NULL,
        sender_type   TEXT NOT NULL DEFAULT 'user',
        content       TEXT NOT NULL,
        message_type  TEXT NOT NULL DEFAULT 'text',
        file_meta     TEXT,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX idx_web_messages_room
        ON web_messages(room_id, created_at);

      -- The room's wired agent. One row per room (single-agent rooms are a
      -- v1 invariant, enforced here by the PK, not just by UI convention).
      CREATE TABLE web_room_primes (
        room_id        TEXT PRIMARY KEY,
        agent_group_id TEXT NOT NULL,
        created_at     INTEGER NOT NULL
      );

      -- One row of install-level web state.
      CREATE TABLE web_settings (
        id                    INTEGER PRIMARY KEY CHECK (id = 1),
        onboarding_complete   INTEGER NOT NULL DEFAULT 0,
        bearer_token_disabled INTEGER NOT NULL DEFAULT 0,
        default_model_id      TEXT,
        updated_at            INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO web_settings (id) VALUES (1);
    `);
  },
};

/** Model roster + per-agent assignment. */
export const moduleWebModels: Migration = {
  version: 2,
  name: 'module:web:models',
  sqliteOnly: true,
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE web_models (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        kind            TEXT NOT NULL,
        endpoint        TEXT,
        model_id        TEXT NOT NULL,
        credential_ref  TEXT,
        created_at      INTEGER NOT NULL
      );

      CREATE TABLE web_agent_models (
        agent_group_id  TEXT PRIMARY KEY,
        model_id        TEXT NOT NULL,
        assigned_at     INTEGER NOT NULL
      );
      CREATE INDEX idx_web_agent_models_model
        ON web_agent_models(model_id);
    `);
  },
};

/**
 * Approval cards: maps a pending approval to every web surface that
 * rendered it (the agent's room card and the owner's inbox), so resolution
 * can flip/clear each copy. Composite PK — one approval, several surfaces.
 */
export const moduleWebApprovals: Migration = {
  version: 3,
  name: 'module:web:approvals',
  sqliteOnly: true,
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE web_approvals_index (
        approval_id   TEXT NOT NULL,
        platform_id   TEXT NOT NULL,
        recorded_at   INTEGER NOT NULL,
        PRIMARY KEY (approval_id, platform_id)
      );
      CREATE INDEX idx_web_approvals_platform
        ON web_approvals_index(platform_id);
    `);
  },
};

export const webMigrations: Migration[] = [moduleWebCore, moduleWebModels, moduleWebApprovals];

// Self-registration: the channel entry (web/index.ts) side-effect-imports
// this module, and src/index.ts imports the channels barrel before running
// migrations — so these are registered by the time runMigrations executes.
// Trunk reserves the `module:` namespace for exactly this API; module
// migrations run after the built-ins, in module import order.
for (const m of webMigrations) registerMigration(m as ModuleMigration);
