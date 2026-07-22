/**
 * skill_drafts CRUD — staged proposals from the learning loop
 * (see docs/webchat/design/learning-loop.md). The SKILL.md body lives on disk at
 * data/skill-drafts/<id>/SKILL.md; this table holds the metadata + status.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './connection.js';
import { DATA_DIR } from '../config.js';

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
export function createSkillDraft(
  d: Omit<SkillDraft, 'status' | 'created_at'> & { body: string },
): void {
  const dir = skillDraftDir(d.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), d.body);
  getDb()
    .prepare(
      `INSERT INTO skill_drafts (id, agent_group_id, session_id, kind, skill_name, target_skill, description, status, created_at)
       VALUES (@id, @agent_group_id, @session_id, @kind, @skill_name, @target_skill, @description, 'pending', @created_at)`,
    )
    .run({
      id: d.id,
      agent_group_id: d.agent_group_id,
      session_id: d.session_id,
      kind: d.kind,
      skill_name: d.skill_name,
      target_skill: d.target_skill,
      description: d.description,
      created_at: Date.now(),
    });
}

export function listSkillDrafts(agentGroupId?: string): SkillDraft[] {
  const sql = agentGroupId
    ? "SELECT * FROM skill_drafts WHERE status = 'pending' AND agent_group_id = ? ORDER BY created_at DESC"
    : "SELECT * FROM skill_drafts WHERE status = 'pending' ORDER BY created_at DESC";
  const stmt = getDb().prepare(sql);
  return (agentGroupId ? stmt.all(agentGroupId) : stmt.all()) as SkillDraft[];
}

export function getSkillDraft(id: string): SkillDraft | undefined {
  return getDb().prepare('SELECT * FROM skill_drafts WHERE id = ?').get(id) as SkillDraft | undefined;
}

/**
 * Replace a pending draft's body (the review-time edit). The description column
 * follows the new front-matter so every list stays in step with the content.
 */
export function updateSkillDraftBody(id: string, body: string): boolean {
  const d = getSkillDraft(id);
  if (!d || d.status !== 'pending') return false;
  const desc = /^---\s*\n[\s\S]*?^\s*description:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? d.description;
  fs.writeFileSync(path.join(skillDraftDir(id), 'SKILL.md'), body);
  getDb().prepare('UPDATE skill_drafts SET description = ? WHERE id = ?').run(desc, id);
  return true;
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
export function resolveSkillDraft(id: string, _status: 'kept' | 'discarded'): boolean {
  const changed = getDb().prepare('DELETE FROM skill_drafts WHERE id = ?').run(id).changes > 0;
  if (changed) fs.rmSync(skillDraftDir(id), { recursive: true, force: true });
  return changed;
}
