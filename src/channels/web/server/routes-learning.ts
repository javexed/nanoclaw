// ── Learning routes: skill drafts + the per-agent auto-learn switch ─────────
// Keep runs the overlap review inline and answers 409 with the overlaps when
// it finds any; the card re-posts with force=true after "keep anyway". Same
// UX as a background job + push, without the job.
import { json, readJsonBody } from './http.js';
import type { RouteCtx } from '../server.js';
import { log } from '../../../log.js';
import { getAgentGroup } from '../../../db/agent-groups.js';
import { getSkillDraft, listSkillDrafts, readSkillDraftBody, resolveSkillDraft } from '../../../modules/learning/db.js';
import { applySkillDraft } from '../../../modules/learning/apply.js';
import { findKeepOverlaps } from '../../../modules/learning/overlap.js';
import { notifySkillDraftResolved } from '../../../modules/learning/events.js';
import { getAgentLearning, setAgentLearning } from '../../../modules/learning/settings.js';
import { getAgentForWebRoom } from '../db.js';

async function parseBody(ctx: RouteCtx): Promise<Record<string, unknown> | null> {
  const raw = await readJsonBody(ctx.req, ctx.res);
  if (raw === null) return null; // readJsonBody already answered
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    json(ctx.res, 400, { error: 'Invalid JSON' });
    return null;
  }
}

/** Pending drafts, newest first — for a surface that lists them. */
export async function rSkillDraftsGet({ res }: RouteCtx): Promise<void> {
  const drafts = await listSkillDrafts();
  return json(res, 200, {
    drafts: await Promise.all(
      drafts.map(async (d) => ({
        id: d.id,
        skillName: d.skill_name,
        description: d.description,
        kind: d.kind,
        targetSkill: d.target_skill,
        agentGroupId: d.agent_group_id,
        agentName: (await getAgentGroup(d.agent_group_id))?.name ?? 'agent',
        createdAt: d.created_at,
      })),
    ),
  });
}

/** One draft with its SKILL.md body — the card's View. */
export async function rSkillDraftGet({ res }: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const id = decodeURIComponent(m[1]);
  const d = await getSkillDraft(id);
  if (!d || d.status !== 'pending') return json(res, 404, { error: 'Draft not found' });
  return json(res, 200, {
    id: d.id,
    skillName: d.skill_name,
    description: d.description,
    kind: d.kind,
    targetSkill: d.target_skill,
    body: readSkillDraftBody(id) ?? '',
  });
}

/**
 * Keep. Overlap review first: token similarity always, a local-model judge
 * when NANOCLAW_OVERLAP_MODEL is set. Advisory — a human overrides with
 * force=true. Any review failure keeps without it; the review is an upgrade,
 * never a gate.
 */
export async function rSkillDraftKeepPost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  const id = decodeURIComponent(m[1]);
  const body = await parseBody(ctx);
  if (body === null) return;
  const draft = await getSkillDraft(id);
  if (!draft || draft.status !== 'pending') return json(res, 404, { error: 'Draft not found' });

  if (body.force !== true) {
    try {
      const overlaps = await findKeepOverlaps(draft);
      if (overlaps.length > 0) {
        return json(res, 409, {
          overlaps: overlaps.map((o) => ({ name: o.name, source: o.source, reason: o.reason })),
        });
      }
    } catch (err) {
      log.warn('Keep overlap review failed — keeping without it', { draftId: id, err: String(err) });
    }
  }

  const r = await applySkillDraft(draft, draft.kind === 'patch' ? 'Skill revision kept' : 'Learned skill kept');
  if (!r.ok) return json(res, r.status, { error: r.error });
  notifySkillDraftResolved({ draftId: id, outcome: 'kept', by: userId });
  return json(res, 200, { ok: true, name: r.name, patched: r.patched, restarted: r.restarted });
}

export async function rSkillDraftDiscardPost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  const id = decodeURIComponent(m[1]);
  if (!(await resolveSkillDraft(id, 'discarded'))) return json(res, 404, { error: 'Draft not found' });
  notifySkillDraftResolved({ draftId: id, outcome: 'discarded', by: userId });
  return json(res, 200, { ok: true });
}

/** Addressed by room id: the room's agent is the room (see migration v4). */
export async function rRoomLearningGet({ res }: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const agent = await getAgentForWebRoom(decodeURIComponent(m[1]));
  if (!agent) return json(res, 404, { error: 'Room not found' });
  return json(res, 200, await getAgentLearning(agent.id));
}

/** Set the switch. Takes effect on the agent's next container spawn (container.json is materialized then). */
export async function rRoomLearningPut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  const agent = await getAgentForWebRoom(decodeURIComponent(m[1]));
  if (!agent) return json(res, 404, { error: 'Room not found' });
  const id = agent.id;
  const body = await parseBody(ctx);
  if (body === null) return;
  const patch: { autoTrigger?: boolean; cooldownMinutes?: number } = {};
  if (typeof body.autoTrigger === 'boolean') patch.autoTrigger = body.autoTrigger;
  if (typeof body.cooldownMinutes === 'number' && Number.isFinite(body.cooldownMinutes)) {
    patch.cooldownMinutes = body.cooldownMinutes;
  }
  return json(res, 200, await setAgentLearning(id, patch));
}
