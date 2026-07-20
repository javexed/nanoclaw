import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Workspace MASTER switch for the learning loop. A singleton (id = 1) row.
 * enabled = 1 (default) → per-agent / per-room learning settings apply as
 * before. enabled = 0 → auto-learn is OFF workspace-wide: materializeContainerJson
 * forces autoTrigger/autoKeep off for every agent (overriding agent and room
 * settings), and the webchat UI hides the per-agent / per-room learning controls.
 */
export const moduleLearningMaster: Migration = {
  version: 205,
  name: 'learning-master',
  up(db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS learning_master (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 1
    )`);
    db.prepare(`INSERT OR IGNORE INTO learning_master (id, enabled) VALUES (1, 1)`).run();
  },
};
