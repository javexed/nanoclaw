import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Learning-loop classifier gate. The auto-review trigger's default is a bare
 * "≥N tools = busy turn" heuristic; when an owner picks a small local model
 * here it decides "was this turn actually worth distilling?" instead. We store
 * the roster model id (for the Settings picker) plus the resolved,
 * CONTAINER-REACHABLE call params (url + model) so materializeContainerJson can
 * inject them into container.json without a roster lookup (keeping core free of
 * a webchat dependency). NULL model id = no classifier (heuristic only).
 */
export const moduleLearningClassifier: Migration = {
  version: 206,
  name: 'learning-classifier',
  up(db: Database.Database) {
    const cols = (db.prepare("PRAGMA table_info('learning_master')").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    if (!cols.includes('classifier_model_id')) {
      db.exec(`ALTER TABLE learning_master ADD COLUMN classifier_model_id TEXT`);
    }
    if (!cols.includes('classifier_url')) {
      db.exec(`ALTER TABLE learning_master ADD COLUMN classifier_url TEXT`);
    }
    if (!cols.includes('classifier_model')) {
      db.exec(`ALTER TABLE learning_master ADD COLUMN classifier_model TEXT`);
    }
  },
};
