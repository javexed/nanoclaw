import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Per-ROOM learning-loop settings (auto-distill / auto-keep), keyed by
 * messaging group — the unit operators actually think in. A room row
 * OVERRIDES the wired agents' per-agent learning config; absent keys fall
 * through to the agent level, then to the defaults (autoTrigger on,
 * autoKeep off). JSON: { autoTrigger?: boolean; autoKeep?: boolean }.
 */
export const moduleLearningRoomSettings: Migration = {
  version: 203,
  name: 'learning-room-settings',
  up(db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS learning_room_settings (
      messaging_group_id TEXT PRIMARY KEY,
      settings TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    )`);
  },
};
