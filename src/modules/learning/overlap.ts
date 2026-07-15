/**
 * Keep-time overlap review (learning loop): when a human presses Keep — or
 * auto-keep fires — the draft is compared against everything the agent can
 * already see: its scoped skills, its OTHER pending drafts, and the shared
 * pool. Overlap is surfaced, never silently enforced: the human gets a
 * "possible overlap with X — keep anyway?" confirm; auto-keep degrades to
 * staged so a human decides.
 *
 * Why at Keep and not only at stage time: the reviewer names skills freely,
 * so exact-name dedup misses twins ("branded-pdf-deliverables" vs
 * "branded-pdf-documents" — a real pair this install produced 84 minutes
 * apart). Keep is the last gate where every candidate is visible.
 *
 * Two layers:
 *   1. Heuristic (always on): token-set similarity over name + description.
 *      Cheap, deterministic, catches the sibling-name case.
 *   2. LLM judge (opt-in): when NANOCLAW_OVERLAP_MODEL is set, shortlisted
 *      candidates are judged by a local model through the LiteLLM router's
 *      Anthropic-format endpoint — no cloud spend, a few seconds, and it
 *      catches overlap the token heuristic can't see.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { listSkillDrafts, readSkillDraftBody, type SkillDraft } from '../../db/skill-drafts.js';

export interface OverlapCandidate {
  name: string;
  description: string;
  source: 'scoped' | 'pending-draft' | 'pool';
}

export interface OverlapHit extends OverlapCandidate {
  score: number;
  reason: string;
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'is', 'it',
  'of', 'on', 'or', 'the', 'this', 'to', 'use', 'via', 'when', 'with', 'you',
  'your',
]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

/** Jaccard over name+description tokens, with a boost for shared name tokens. */
export function overlapScore(
  a: { name: string; description: string },
  b: { name: string; description: string },
): number {
  const ta = tokens(`${a.name} ${a.description}`);
  const tb = tokens(`${b.name} ${b.description}`);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const jaccard = shared / (ta.size + tb.size - shared);
  const na = tokens(a.name);
  const nb = tokens(b.name);
  let nameShared = 0;
  for (const t of na) if (nb.has(t)) nameShared++;
  const nameBoost = na.size && nb.size ? nameShared / Math.min(na.size, nb.size) : 0;
  return Math.min(1, jaccard + 0.3 * nameBoost);
}

/** Heuristic shortlist threshold — tuned so sibling-name twins clear it. */
export const OVERLAP_SHORTLIST = 0.3;
/** Heuristic-only flag threshold (no LLM judge configured). */
export const OVERLAP_FLAG = 0.45;

function frontMatter(md: string): { name: string; description: string } {
  const fm = md.match(/^---\s*\n([\s\S]*?)\n---/);
  const pick = (k: string) => fm?.[1].match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))?.[1].trim() ?? '';
  return { name: pick('name'), description: pick('description') };
}

/** Everything a Keep for this agent could collide with (excluding the draft itself). */
export function gatherOverlapCandidates(
  agentGroupId: string,
  excludeDraftId: string,
  dataDir: string = DATA_DIR,
): OverlapCandidate[] {
  const out: OverlapCandidate[] = [];
  const scopedDir = path.join(dataDir, 'v2-sessions', agentGroupId, '.claude-shared', 'skills');
  try {
    for (const entry of fs.readdirSync(scopedDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      try {
        const md = fs.readFileSync(path.join(scopedDir, entry.name, 'SKILL.md'), 'utf8');
        out.push({ name: entry.name, description: frontMatter(md).description, source: 'scoped' });
      } catch {
        continue;
      }
    }
  } catch {
    /* no scoped skills yet */
  }
  try {
    for (const d of listSkillDrafts()) {
      if (d.id === excludeDraftId || d.agent_group_id !== agentGroupId) continue;
      out.push({ name: d.skill_name, description: d.description ?? '', source: 'pending-draft' });
    }
  } catch {
    /* central DB unavailable (tests, early boot) — scoped+pool still checked */
  }
  for (const poolRoot of [path.join(process.cwd(), 'container', 'skills'), path.join(process.cwd(), 'data', 'user-skills')]) {
    try {
      for (const entry of fs.readdirSync(poolRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        try {
          const md = fs.readFileSync(path.join(poolRoot, entry.name, 'SKILL.md'), 'utf8');
          out.push({ name: entry.name, description: frontMatter(md).description, source: 'pool' });
        } catch {
          continue;
        }
      }
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * Optional LLM judge over the heuristic shortlist. Uses the local router's
 * Anthropic-format /v1/messages (LiteLLM) — configured via .env:
 *   NANOCLAW_OVERLAP_MODEL=gemma4:latest   (unset = heuristic only)
 *   NANOCLAW_OVERLAP_URL=http://127.0.0.1:4000   (default)
 * Any failure degrades to the heuristic verdict — the judge is an upgrade,
 * never a dependency.
 */
async function llmJudge(
  draft: { name: string; description: string; body: string },
  candidates: OverlapHit[],
): Promise<OverlapHit[] | null> {
  const env = { ...readEnvFile(['NANOCLAW_OVERLAP_MODEL', 'NANOCLAW_OVERLAP_URL']), ...process.env };
  const model = env.NANOCLAW_OVERLAP_MODEL;
  if (!model) return null;
  const url = (env.NANOCLAW_OVERLAP_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
  const list = candidates
    .map((c, i) => `${i + 1}. name: ${c.name}\n   covers: ${c.description || '(no description)'}`)
    .join('\n');
  const prompt =
    `A coding agent wants to save a new skill:\n` +
    `name: ${draft.name}\ncovers: ${draft.description}\n\n` +
    `Existing skills:\n${list}\n\n` +
    `Which existing skills (if any) cover materially the SAME capability as the new one — ` +
    `such that keeping both would be redundant? Similar domain alone is NOT overlap; ` +
    `the same job done the same way is. ` +
    `Answer with ONLY JSON: {"overlaps":[{"n":<number>,"why":"<short reason>"}]} — empty array if none.`;
  try {
    const r = await fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'sk-local', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
      // Keep is interactive — a cold local model must not hang the button.
      // The heuristic verdict is the backstop; a warm model answers in ~2-5s.
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as { content?: { text?: string }[] };
    const text = data.content?.map((c) => c.text ?? '').join('') ?? '';
    const jsonStart = text.indexOf('{');
    if (jsonStart === -1) return null;
    const parsed = JSON.parse(text.slice(jsonStart, text.lastIndexOf('}') + 1)) as {
      overlaps?: { n?: number; why?: string }[];
    };
    return (parsed.overlaps ?? [])
      .map((o) => {
        const c = candidates[(o.n ?? 0) - 1];
        return c ? { ...c, reason: (o.why || c.reason).slice(0, 160) } : null;
      })
      .filter((c): c is OverlapHit => !!c);
  } catch (err) {
    log.warn('Overlap LLM judge failed — falling back to heuristic', { err: String(err) });
    return null;
  }
}

/**
 * The Keep gate: overlaps worth telling a human about. Empty = keep freely.
 * With the LLM judge configured, its verdict over the shortlist wins; without
 * it, only strong heuristic hits (≥ OVERLAP_FLAG) are surfaced.
 */
export async function findKeepOverlaps(draft: SkillDraft): Promise<OverlapHit[]> {
  const body = readSkillDraftBody(draft.id) ?? '';
  const me = { name: draft.skill_name, description: draft.description ?? '', body };
  // A patch REPLACES its target by design — the target is not "overlap".
  const targetName = draft.kind === 'patch' ? draft.target_skill : null;
  const shortlist: OverlapHit[] = gatherOverlapCandidates(draft.agent_group_id, draft.id)
    .filter((c) => c.name !== targetName)
    .map((c) => ({
      ...c,
      score: overlapScore(me, c),
      reason: `similar name/description`,
    }))
    .filter((c) => c.score >= OVERLAP_SHORTLIST)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  if (shortlist.length === 0) return [];
  const judged = await llmJudge(me, shortlist);
  if (judged) return judged;
  return shortlist.filter((c) => c.score >= OVERLAP_FLAG);
}
