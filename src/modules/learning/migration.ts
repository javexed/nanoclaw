/**
 * Learning-loop schema. `skill_drafts` holds staged proposals (body on disk at
 * data/skill-drafts/<id>/SKILL.md); `learning_agent_settings` the per-agent
 * auto-trigger switch. Both are module-owned — nothing here touches a core table.
 */
import type Database from 'better-sqlite3';

import { registerMigration, type Migration, type ModuleMigration } from '../../db/migrations/index.js';

export const moduleLearningSkillDrafts: Migration = {
  version: 1,
  name: 'module:learning:skill-drafts',
  sqliteOnly: true,
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE skill_drafts (
        id             TEXT PRIMARY KEY,
        agent_group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        session_id     TEXT,
        kind           TEXT NOT NULL DEFAULT 'create',
        skill_name     TEXT NOT NULL,
        target_skill   TEXT,
        description    TEXT NOT NULL DEFAULT '',
        status         TEXT NOT NULL DEFAULT 'pending',
        created_at     INTEGER NOT NULL
      );
      CREATE INDEX idx_skill_drafts_group_status
        ON skill_drafts(agent_group_id, status);
      CREATE TABLE learning_agent_settings (
        agent_group_id   TEXT PRIMARY KEY REFERENCES agent_groups(id) ON DELETE CASCADE,
        auto_trigger     INTEGER NOT NULL DEFAULT 1,
        cooldown_minutes INTEGER NOT NULL DEFAULT 30
      );
    `);
  },
};

// Self-registration, the same way the web channel registers its migrations:
// the module barrel side-effect-imports this file before runMigrations runs.
registerMigration(moduleLearningSkillDrafts as ModuleMigration);
