import type { Migration } from './index.js';

/**
 * `skill_drafts` — staged, not-yet-live skills proposed by the learning loop
 * (see docs/webchat/design/learning-loop.md). A container agent emits a `propose_skill`
 * system action; the host stages it here (+ the SKILL.md body under
 * data/skill-drafts/<id>/) and surfaces it in the webchat "Proposed skills"
 * review. Nothing runs in any agent until an admin keeps + wires it.
 *
 * `kind` = 'create' (a new skill) | 'patch' (a proposed change to an existing
 * one; `target_skill` names it). `status` stays 'pending' until kept/discarded.
 */
export const moduleLearningSkillDrafts: Migration = {
  version: 200,
  name: 'learning-skill-drafts',
  up(db) {
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
    `);
  },
};
