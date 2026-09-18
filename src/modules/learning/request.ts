/**
 * Host side of the `propose_skill` system action. A container agent's
 * `draft_skill` tool emits it to outbound.db; this stages the draft — never
 * live — and fires `skillDraftProposed` so the channel can surface a card.
 * Keep is a separate human step (apply.ts).
 */
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { createSkillDraft, listSkillDrafts, resolveSkillDraft } from './db.js';
import { notifySkillDraftProposed, notifySkillDraftResolved } from './events.js';

function sanitizeSkillName(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export async function handleProposeSkill(content: Record<string, unknown>, session: Session): Promise<void> {
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
  const description = descM
    ? descM[1]
        .trim()
        .replace(/^["']|["']$/g, '')
        .slice(0, 200)
    : '';

  const id = `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // One pending draft per (agent, name): the auto-trigger and a manual /learn
  // can both stage the same lesson, and twins in the queue are pure noise.
  // The newer draft supersedes — its body reflects the later look at the session.
  for (const prior of await listSkillDrafts()) {
    if (prior.agent_group_id !== session.agent_group_id) continue;
    if (prior.skill_name !== skillName) continue;
    await resolveSkillDraft(prior.id, 'discarded');
    notifySkillDraftResolved({ draftId: prior.id, outcome: 'discarded', by: 'superseded' });
    log.info('Pending draft superseded by a newer one', { old: prior.id, skillName });
  }

  await createSkillDraft({
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

  notifySkillDraftProposed({
    draftId: id,
    skillName,
    description,
    kind,
    targetSkill: kind === 'patch' ? target : null,
    agentGroupId: session.agent_group_id,
    agentName: (await getAgentGroup(session.agent_group_id))?.name ?? 'agent',
    session,
  });
}
