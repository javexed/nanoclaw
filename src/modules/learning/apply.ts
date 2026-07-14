/**
 * Applying a kept skill draft — the one write path, shared by the webchat Keep
 * button and the auto-keep option (docs/learning-loop.md §4).
 *
 * Two callers, one implementation, because this is the security-sensitive
 * write: a kept skill becomes agent context on the next spawn. Extracted from
 * the webchat keep handler so auto-keep cannot drift into a second, subtly
 * different set of rules.
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
import { readSkillDraftBody, resolveSkillDraft, type SkillDraft } from '../../db/skill-drafts.js';
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
export function applySkillDraft(draft: SkillDraft, restartReason: string): ApplyResult {
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

  // Revision history: a patch REPLACES its target, and a bad revision (worse
  // with auto-keep on) must be recoverable. Snapshot the outgoing version under
  // .history/<name>/<ts>/ — dot-prefixed, so every skill scanner skips it.
  if (isPatch && fs.existsSync(dest)) {
    try {
      snapshotRevision(dir0, name);
    } catch {
      /* history is protection, not a gate — never block the keep */
    }
  }

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
  resolveSkillDraft(draft.id, 'kept');
  const restarted = restartAgentGroupContainers(draft.agent_group_id, restartReason);
  return { ok: true, status: 200, name, patched: isPatch, forkedFromPool, restarted };
}

/** Copy the CURRENT version of a skill into its revision history. */
export function snapshotRevision(skillsDir: string, name: string): string {
  const src = path.join(skillsDir, name);
  const dest = path.join(skillsDir, '.history', name, String(Date.now()));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  return dest;
}

/** Newest-first revision timestamps for a skill (empty when never revised). */
export function listRevisions(skillsDir: string, name: string): number[] {
  try {
    return fs
      .readdirSync(path.join(skillsDir, '.history', name))
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => b - a);
  } catch {
    return [];
  }
}

/**
 * Revert a skill to its newest history snapshot. The reverted-away version is
 * itself snapshotted first, so a revert is always revertible — history only
 * ever grows, nothing is destroyed.
 */
export function revertLastRevision(skillsDir: string, name: string): { ok: boolean; error?: string } {
  const revs = listRevisions(skillsDir, name);
  if (revs.length === 0) return { ok: false, error: 'No revision history' };
  const dest = path.join(skillsDir, name);
  if (!fs.existsSync(dest)) return { ok: false, error: 'Skill not found' };
  const snap = path.join(skillsDir, '.history', name, String(revs[0]));
  snapshotRevision(skillsDir, name); // current → history, so the revert is undoable
  const staging = `${dest}.reverting`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.cpSync(snap, staging, { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(staging, dest);
  fs.rmSync(snap, { recursive: true, force: true });
  return { ok: true };
}
