/**
 * Learning loop — host side of the `propose_skill` system action
 * (see docs/design/learning-loop.md).
 *
 * A container agent's `draft_skill` MCP tool emits a `propose_skill` action to
 * outbound.db. This stages it as a DRAFT (never live) for review in the webchat
 * "Proposed skills" surface. Approval → wire is a separate, admin-gated step.
 */
import type Database from 'better-sqlite3';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { createSkillDraft } from '../../db/skill-drafts.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { notifySkillDraftProposed, notifySkillDraftResolved } from './events.js';
import { applySkillDraft } from './apply.js';
import { getSkillDraft, listSkillDrafts, resolveSkillDraft } from '../../db/skill-drafts.js';
import { getContainerConfig } from '../../db/container-configs.js';

function sanitizeSkillName(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export async function handleProposeSkill(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const skillName = sanitizeSkillName(String(content.skill_name || content.name || ''));
  const body = String(content.body || '');
  const kind = content.kind === 'patch' ? 'patch' : 'create';
  const target = content.target_skill ? sanitizeSkillName(String(content.target_skill)) : null;

  if (!skillName || !body) {
    log.warn('propose_skill ignored — missing name/body', { sessionId: session.id, skillName });
    return;
  }
  // Must have front-matter with a description, like any SKILL.md.
  const fm = body.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fm || !/^description:\s*\S/m.test(fm[1])) {
    log.warn('propose_skill ignored — SKILL.md needs front-matter description', { sessionId: session.id, skillName });
    return;
  }
  const descM = fm[1].match(/^description:\s*(.+)$/m);
  const description = descM ? descM[1].trim().replace(/^["']|["']$/g, '').slice(0, 200) : '';

  const id = `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // One pending draft per (agent, name): auto-trigger plus a manual /learn can
  // both stage the same lesson, and twins in the review queue are pure noise.
  // The newer draft supersedes — its body reflects the later look at the session.
  for (const prior of listSkillDrafts()) {
    if (prior.agent_group_id !== session.agent_group_id) continue;
    if (prior.skill_name !== skillName) continue;
    resolveSkillDraft(prior.id, 'discarded');
    notifySkillDraftResolved({ draftId: prior.id, outcome: 'discarded', by: 'superseded' });
    log.info('Pending draft superseded by a newer one', { old: prior.id, skillName });
  }

  createSkillDraft({
    id,
    agent_group_id: session.agent_group_id,
    session_id: session.id,
    kind,
    skill_name: skillName,
    target_skill: kind === 'patch' ? target : null,
    description,
    body,
  });
  log.info('Skill draft staged', { id, agentGroup: session.agent_group_id, skillName, kind });

  // Surface it where the work happened: each channel decides how (webchat drops
  // an actionable card into the agent's own room).
  notifySkillDraftProposed({
    draftId: id,
    skillName,
    description,
    kind,
    targetSkill: kind === 'patch' ? target : null,
    agentGroupId: session.agent_group_id,
    agentName: getAgentGroup(session.agent_group_id)?.name ?? 'agent',
    session,
  });

  // Auto-keep (docs/learning-loop.md §4) — OFF unless an owner/global admin
  // switched it on for this agent. It reuses the exact same apply path as the
  // human Keep, so the only thing autonomy removes is the wait, never a rule.
  if (isAutoKeepEnabled(session.agent_group_id)) {
    const draft = getSkillDraft(id);
    if (draft) {
      const r = applySkillDraft(draft, 'Learning auto-keep applied a skill draft');
      if (r.ok) {
        log.info('Skill draft auto-kept', { id, agentGroup: session.agent_group_id, name: r.name, patched: r.patched });
        notifySkillDraftResolved({ draftId: id, outcome: 'kept', by: 'auto-keep' });
      } else {
        // Failed auto-keep degrades to the normal staged flow — the draft stays
        // pending for a human, nothing is lost.
        log.error('Auto-keep failed; draft stays pending', { id, error: r.error });
      }
    }
  }
}

function isAutoKeepEnabled(agentGroupId: string): boolean {
  try {
    const raw = getContainerConfig(agentGroupId)?.learning;
    if (!raw) return false;
    return (JSON.parse(raw) as { autoKeep?: boolean }).autoKeep === true;
  } catch {
    return false;
  }
}
