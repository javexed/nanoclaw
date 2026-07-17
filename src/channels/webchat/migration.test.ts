/**
 * Migration tests — verifies the webchat schema lands cleanly, has the
 * right indexes, and survives a re-run (which exercises both the
 * `IF NOT EXISTS` guards and the `runMigrations` name-based dedupe).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

beforeEach(() => {
  initTestDb();
});

afterEach(() => {
  closeDb();
});

describe('moduleWebchat migration', () => {
  it('leaves the expected tables after all webchat migrations', () => {
    runMigrations(getDb());
    // After all webchat migrations:
    //   webchat-initial          → webchat_rooms, webchat_messages, webchat_push_subscriptions
    //   webchat-drop-rooms       → drops webchat_rooms (data moved to messaging_groups)
    //   webchat-room-primes      → adds webchat_room_primes
    //   webchat-models           → adds webchat_models, webchat_agent_models
    //   webchat-room-settings    → adds webchat_room_settings
    //   webchat-approvals-index  → adds webchat_approvals_index
    //   webchat-user-archives    → adds webchat_user_room_archives
    //   webchat-archive-split    → adds webchat_room_archives, renames webchat_user_room_archives → webchat_user_room_hides
    const tables = getDb()
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'webchat_%' ORDER BY name`)
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual([
      'webchat_agent_mcp_servers',
      'webchat_agent_models',
      'webchat_approvals_index',
      'webchat_disabled_sources',
      'webchat_mcp_servers',
      'webchat_messages',
      'webchat_messages_fts',
      'webchat_messages_fts_config',
      'webchat_messages_fts_data',
      'webchat_messages_fts_docsize',
      'webchat_messages_fts_idx',
      'webchat_models',
      'webchat_push_subscriptions',
      'webchat_room_archives',
      'webchat_room_pins',
      'webchat_room_primes',
      'webchat_room_reads',
      'webchat_room_settings',
      'webchat_settings',
      'webchat_skill_sources',
      'webchat_thread_engaged',
      'webchat_thread_reads',
      'webchat_thread_sync',
      'webchat_threads',
      'webchat_user_handles',
      'webchat_user_room_hides',
    ]);
  });

  it('creates the expected indexes', () => {
    runMigrations(getDb());
    const indexes = getDb()
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_webchat_%' ORDER BY name`)
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name).sort()).toEqual(
      [
        'idx_webchat_agent_mcp_servers_server',
        'idx_webchat_agent_models_model',
        'idx_webchat_approvals_platform',
        'idx_webchat_engaged_thread',
        'idx_webchat_messages_room',
        'idx_webchat_messages_thread',
        'idx_webchat_push_identity',
        'idx_webchat_room_pins_user',
        'idx_webchat_room_reads_user',
        'idx_webchat_user_handles_handle',
        'idx_webchat_user_hides_user',
      ].sort(),
    );
  });

  it('records all webchat migrations in schema_version', () => {
    runMigrations(getDb());
    const rows = getDb().prepare(`SELECT name FROM schema_version WHERE name LIKE 'webchat-%' ORDER BY name`).all() as {
      name: string;
    }[];
    expect(rows.map((r) => r.name)).toEqual([
      'webchat-approvals-index',
      'webchat-approvals-index-fanout',
      'webchat-archive-split',
      'webchat-bearer-auth',
      'webchat-credentials-config',
      'webchat-default-model',
      'webchat-disabled-builtins',
      'webchat-drop-rooms',
      'webchat-initial',
      'webchat-marketplace-toggle',
      'webchat-mcp-hardening',
      'webchat-mcp-servers',
      'webchat-message-fts',
      'webchat-models',
      'webchat-onboarding',
      'webchat-read-aloud',
      'webchat-room-credential-mode',
      'webchat-room-oauth-allowed',
      'webchat-room-pin-order',
      'webchat-room-pins',
      'webchat-room-primes',
      'webchat-room-reads',
      'webchat-room-settings',
      'webchat-skill-sources',
      'webchat-skill-sources-official',
      'webchat-stt',
      'webchat-stt-prompt',
      'webchat-tailscale-owner',
      'webchat-thread-context-sync',
      'webchat-thread-engaged',
      'webchat-threads',
      'webchat-user-archives',
      'webchat-user-handles',
    ]);
  });

  it('is a no-op on re-run (name-based dedupe)', () => {
    runMigrations(getDb());
    // Second invocation must not throw — runMigrations dedupes by name,
    // and webchat-initial's IF NOT EXISTS guards plus webchat-drop-rooms'
    // table-existence check make the whole pass idempotent.
    expect(() => runMigrations(getDb())).not.toThrow();
  });

  it('legacy install upgrade: webchat-drop-rooms migrates webchat_rooms data into messaging_groups', () => {
    // Simulate an older install that has webchat-initial applied but NOT
    // webchat-drop-rooms (the schema state of installs predating this migration).
    const db = getDb();
    // Manually apply just the legacy schema + schema_version (normally
    // created by runMigrations on first call).
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied TEXT NOT NULL
      );
      CREATE TABLE webchat_rooms (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE webchat_messages (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES webchat_rooms(id) ON DELETE CASCADE,
        sender TEXT NOT NULL, sender_type TEXT NOT NULL DEFAULT 'user',
        content TEXT NOT NULL, message_type TEXT NOT NULL DEFAULT 'text',
        file_meta TEXT, created_at INTEGER NOT NULL
      );
    `);
    db.prepare(`INSERT INTO webchat_rooms VALUES ('legacy-room', 'Legacy', ?)`).run(Date.now());
    // Mark webchat-initial as already applied so only the new migration runs.
    db.prepare(`INSERT INTO schema_version (version, name, applied) VALUES (100, 'webchat-initial', ?)`).run(
      new Date().toISOString(),
    );

    runMigrations(db);

    // After: webchat_rooms is gone, but the legacy room got a corresponding
    // messaging_groups row.
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='webchat_rooms'`).all();
    expect(tables).toEqual([]);
    const mg = db.prepare(`SELECT platform_id, name FROM messaging_groups WHERE channel_type='webchat'`).get() as {
      platform_id: string;
      name: string;
    };
    expect(mg.platform_id).toBe('legacy-room');
    expect(mg.name).toBe('Legacy');
  });

  it('webchat_messages survives the FK drop (data migrates intact)', () => {
    const db = getDb();
    // Same legacy seed as the test above.
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied TEXT NOT NULL
      );
      CREATE TABLE webchat_rooms (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE webchat_messages (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES webchat_rooms(id) ON DELETE CASCADE,
        sender TEXT NOT NULL, sender_type TEXT NOT NULL DEFAULT 'user',
        content TEXT NOT NULL, message_type TEXT NOT NULL DEFAULT 'text',
        file_meta TEXT, created_at INTEGER NOT NULL
      );
    `);
    db.prepare(`INSERT INTO webchat_rooms VALUES ('r1', 'R', ?)`).run(Date.now());
    db.prepare(
      `INSERT INTO webchat_messages (id, room_id, sender, content, created_at) VALUES ('m1', 'r1', 'alice', 'hi', ?)`,
    ).run(Date.now());
    db.prepare(`INSERT INTO schema_version (version, name, applied) VALUES (100, 'webchat-initial', ?)`).run(
      new Date().toISOString(),
    );

    runMigrations(db);

    const msg = db.prepare(`SELECT id, room_id, sender, content FROM webchat_messages WHERE id='m1'`).get() as {
      id: string;
      room_id: string;
      sender: string;
      content: string;
    };
    expect(msg).toEqual({ id: 'm1', room_id: 'r1', sender: 'alice', content: 'hi' });
  });
});
