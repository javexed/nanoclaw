/**
 * Applying a kept skill draft — the one write path behind the Keep button.
 * This is the security-sensitive write: a kept skill becomes agent context on
 * the next spawn, so the rules live in one place.
 *
 * The rules it enforces:
 *   - SCOPED only — the skill lands in the one agent's own skills dir, never
 *     the shared pool.
 *   - a NEW skill must not shadow a pooled one (name clash ≠ revision);
 *   - a PATCH replaces its target — and patching a pooled skill forks it into
 *     the agent's scoped copy, leaving the pool untouched;
 *   - provenance survives a revision; only genuinely new skills are 'learned'.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { readSkillDraftBody, resolveSkillDraft, type SkillDraft } from './db.js';
import { restartAgentGroupContainers } from '../../container-restart.js';

export function sanitizeSkillName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function scopedSkillsDir(agentGroupId: string): string {
  return path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.claude-shared', 'skills');
}

export interface SkillOriginInfo {
  label: string;
  url?: string;
  official?: boolean;
}

function readOrigin(skillDir: string): SkillOriginInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(skillDir, '.origin.json'), 'utf8')) as SkillOriginInfo;
    return raw && typeof raw.label === 'string' ? raw : null;
  } catch {
    return null;
  }
}

export interface ApplyResult {
  ok: boolean;
  status: number;
  name?: string;
  patched?: boolean;
  forkedFromPool?: boolean;
  restarted?: number;
  error?: string;
}

/**
 * Write the draft's SKILL.md to its destination, resolve the draft, restart the
 * agent. `restartReason` names who kept it — a human or auto-keep — so the
 * container-restart log stays attributable.
 */
export async function applySkillDraft(draft: SkillDraft, restartReason: string): Promise<ApplyResult> {
  const body = readSkillDraftBody(draft.id);
  if (!body) return { ok: false, status: 410, error: 'Draft body missing' };

  const isPatch = draft.kind === 'patch' && !!draft.target_skill;
  const name = sanitizeSkillName(isPatch ? String(draft.target_skill) : draft.skill_name);
  if (!name) return { ok: false, status: 400, error: 'Invalid skill name' };

  const dir0 = scopedSkillsDir(draft.agent_group_id);
  const dest = path.join(dir0, name);
  const pooled =
    fs.existsSync(path.join(process.cwd(), 'container', 'skills', name)) ||
    fs.existsSync(path.join(process.cwd(), 'data', 'user-skills', name));

  if (!isPatch && pooled) {
    // A brand-new skill must not shadow a shared one — that's a name clash, not
    // a revision. (A patch legitimately may: it forks, below.)
    return { ok: false, status: 409, error: `A shared skill named "${name}" already exists` };
  }
  const forkedFromPool = isPatch && pooled && !fs.existsSync(dest);

  // Preserve provenance across a revision; only a genuinely new skill is 'learned'.
  const origin: SkillOriginInfo = readOrigin(dest) ?? { label: 'learned', official: false };

  const staging = `${dest}.importing`;
  try {
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'SKILL.md'), body);
    fs.writeFileSync(path.join(staging, '.origin.json'), JSON.stringify(origin));
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(staging, dest);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    return { ok: false, status: 500, error: 'Write failed: ' + (err instanceof Error ? err.message : String(err)) };
  }
  await resolveSkillDraft(draft.id, 'kept');
  const restarted = await restartAgentGroupContainers(draft.agent_group_id, restartReason);
  return { ok: true, status: 200, name, patched: isPatch, forkedFromPool, restarted };
}
