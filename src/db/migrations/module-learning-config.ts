import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Per-agent learning-loop settings (design §1: "per-agent opt-in").
 *
 * JSON blob: { autoTrigger?: boolean; autoKeep?: boolean; cooldownMinutes?: number }
 *
 * Absent keys mean defaults: autoTrigger ON (a busy turn stages a draft — the
 * human gate survives at Keep), autoKeep OFF (accepting self-written agent
 * context without review is the one autonomy step that needs an explicit,
 * owner-level opt-in).
 */
export const moduleLearningConfig: Migration = {
  version: 201,
  name: 'learning-config',
  up(db: Database.Database) {
    const has = (db.prepare("PRAGMA table_info('container_configs')").all() as Array<{ name: string }>).some(
      (c) => c.name === 'learning',
    );
    if (!has) {
      db.exec(`ALTER TABLE container_configs ADD COLUMN learning TEXT NOT NULL DEFAULT '{}'`);
    }
  },
};
