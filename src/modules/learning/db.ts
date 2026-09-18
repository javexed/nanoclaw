/**
 * skill_drafts CRUD — staged proposals from the learning loop
 * (learning loop). The SKILL.md body lives on disk at
 * data/skill-drafts/<id>/SKILL.md; this table holds the metadata + status.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../../db/connection.js';
import { DATA_DIR } from '../../config.js';

export interface SkillDraft {
  id: string;
  agent_group_id: string;
  session_id: string | null;
  kind: 'create' | 'patch';
  skill_name: string;
  target_skill: string | null;
  description: string;
  status: 'pending' | 'kept' | 'discarded';
  created_at: number;
}

const DRAFTS_DIR = path.join(DATA_DIR, 'skill-drafts');

export function skillDraftDir(id: string): string {
  return path.join(DRAFTS_DIR, id);
}

/** Stage a draft: metadata row + the SKILL.md body on disk. */
export async function createSkillDraft(d: Omit<SkillDraft, 'status' | 'created_at'> & { body: string }): Promise<void> {
  const dir = skillDraftDir(d.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), d.body);
  await getDb().run(
    `INSERT INTO skill_drafts (id, agent_group_id, session_id, kind, skill_name, target_skill, description, status, created_at)
       VALUES (@id, @agent_group_id, @session_id, @kind, @skill_name, @target_skill, @description, 'pending', @created_at)`,
    {
      id: d.id,
      agent_group_id: d.agent_group_id,
      session_id: d.session_id,
      kind: d.kind,
      skill_name: d.skill_name,
      target_skill: d.target_skill,
      description: d.description,
      created_at: Date.now(),
    },
  );
}

export async function listSkillDrafts(agentGroupId?: string): Promise<SkillDraft[]> {
  const sql = agentGroupId
    ? "SELECT * FROM skill_drafts WHERE status = 'pending' AND agent_group_id = ? ORDER BY created_at DESC"
    : "SELECT * FROM skill_drafts WHERE status = 'pending' ORDER BY created_at DESC";
  return (await (agentGroupId ? getDb().all(sql, agentGroupId) : getDb().all(sql))) as SkillDraft[];
}

export async function getSkillDraft(id: string): Promise<SkillDraft | undefined> {
  return (await getDb().get('SELECT * FROM skill_drafts WHERE id = ?', id)) as SkillDraft | undefined;
}

export function readSkillDraftBody(id: string): string | null {
  try {
    return fs.readFileSync(path.join(skillDraftDir(id), 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Resolve a draft (kept or discarded): a terminal state carries no value, so we
 * DELETE the row + its staged files. (Keeping a resolved row around would also
 * pin the agent_groups FK, blocking agent deletion.)
 */
export async function resolveSkillDraft(id: string, _status: 'kept' | 'discarded'): Promise<boolean> {
  const changed = (await getDb().run('DELETE FROM skill_drafts WHERE id = ?', id)).changes > 0;
  if (changed) fs.rmSync(skillDraftDir(id), { recursive: true, force: true });
  return changed;
}
