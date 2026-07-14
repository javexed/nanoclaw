/**
 * draft_skill MCP tool — the learning loop's authoring surface
 * (see docs/design/learning-loop.md).
 *
 * When you've just worked out a reusable, non-obvious procedure, call this to
 * DRAFT a skill from it. Fire-and-forget: it writes a `propose_skill` system
 * action; the host stages it as a draft for admin review in the webchat
 * "Proposed skills" surface. Nothing runs in any agent until an admin keeps it.
 *
 * This is authoring only — it can't wire, install, or run anything.
 *
 * UPDATE BEFORE CREATE. A learning loop that only ever *creates* fills the
 * library with near-duplicates: the same lesson, re-learned and re-filed under a
 * slightly different name every time it comes up. The guard is showing the agent
 * what it already has. The tool description below is built at registration time
 * from the skills actually mounted for this session, so the model can match
 * against real names instead of being told to "prefer a patch" over skills it
 * cannot see. The handler then enforces the hierarchy rather than trusting it:
 * a 'create' whose name collides with an existing skill is coerced to a patch,
 * and a 'patch' at a target that doesn't exist is rejected with the valid list.
 */
import fs from 'fs';
import path from 'path';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}
function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}
function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

/** The agent's live skills mount (symlinks = pooled, real dirs = scoped to it). */
const SKILLS_DIR = process.env.CLAUDE_SKILLS_DIR || '/home/node/.claude/skills';

export interface ExistingSkill {
  name: string;
  description: string;
}

/** Parse `description:` out of a SKILL.md's YAML front-matter. */
export function skillDescription(src: string): string {
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(src);
  if (!fm) return '';
  const d = /^\s*description:\s*(.+)$/m.exec(fm[1]);
  return d ? d[1].trim().replace(/^["']|["']$/g, '') : '';
}

export function readExistingSkills(dir: string = SKILLS_DIR): ExistingSkill[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ExistingSkill[] = [];
  for (const e of entries) {
    // Pooled skills are symlinks, scoped ones are real dirs — both count.
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    try {
      const src = fs.readFileSync(path.join(dir, e.name, 'SKILL.md'), 'utf8');
      out.push({ name: e.name, description: skillDescription(src) });
    } catch {
      /* no readable SKILL.md — not a skill */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const BASE_DESC =
  "Draft a reusable skill from what you just did — use it after resolving a non-obvious, repeatable procedure (a multi-step workflow, a fix for a tricky error, a task the user corrected you on). Fire-and-forget: it stages a DRAFT for the admin to review and wire; it does NOT go live and cannot run anything. DON'T draft for: environment-specific failures (missing binaries), transient errors that resolved, or one-off tasks.";

export function buildDescription(existing: ExistingSkill[]): string {
  if (existing.length === 0) return BASE_DESC;
  const list = existing.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ''}`).join('\n');
  return `${BASE_DESC}

UPDATE BEFORE CREATE. You already have these skills:
${list}

If what you learned belongs to one of the skills above — even partially, even as one more pitfall or a sharper verification step — do NOT write a new near-duplicate. Call this with kind='patch' and target_skill set to that skill's exact name, and pass the COMPLETE revised SKILL.md as body: the whole file with your lesson folded in, not a fragment and not a diff. Use kind='create' only when nothing above covers it.`;
}

export type DraftDecision = { kind: 'create' | 'patch'; target?: string } | { error: string };

/**
 * The update-before-create hierarchy, as a decision — enforced, not merely
 * suggested to the model:
 *
 *   patch at a target that doesn't exist  → reject, listing the real names
 *   create whose name already exists      → coerce to a patch of that skill
 *   otherwise                             → create
 *
 * The coercion is the important one: without it, an agent that re-learns the same
 * lesson simply re-files it, and the library grows a near-duplicate every time.
 */
export function resolveDraftKind(
  requestedKind: unknown,
  name: string,
  requestedTarget: string,
  existing: ExistingSkill[],
): DraftDecision {
  const names = new Set(existing.map((s) => s.name));
  const target = requestedTarget.trim();

  if (requestedKind === 'patch') {
    if (!target) return { error: "kind='patch' requires target_skill (the exact name of the skill you're revising)" };
    if (!names.has(target)) {
      const known = existing.length ? existing.map((s) => s.name).join(', ') : '(none)';
      return { error: `No skill named "${target}". Existing skills: ${known}. Use kind='create' if none of them fit.` };
    }
    return { kind: 'patch', target };
  }
  if (names.has(name)) return { kind: 'patch', target: name };
  return { kind: 'create' };
}

const existingAtStartup = readExistingSkills();

export const draftSkill: McpToolDefinition = {
  tool: {
    name: 'draft_skill',
    description: buildDescription(existingAtStartup),
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Skill id — lowercase, hyphenated, ≤64 chars' },
        body: {
          type: 'string',
          description:
            'The full SKILL.md: YAML front-matter (name + a one-line description of the capability) then the procedure — When to use, Prerequisites, Procedure (exact commands), Pitfalls, Verification. When patching, this is the COMPLETE revised file, not a fragment. Never invent flags, paths, or APIs.',
        },
        kind: {
          type: 'string',
          enum: ['create', 'patch'],
          description: "'patch' an existing skill (preferred when one fits) or 'create' a new one",
        },
        target_skill: { type: 'string', description: "When kind='patch', the exact name of the existing skill being revised" },
      },
      required: ['name', 'body'],
    },
  },
  async handler(args) {
    const name = String(args.name || '').trim();
    const body = String(args.body || '');
    if (!name || !body) return err('name and body are required');
    if (!/^---\s*\n[\s\S]*?description:\s*\S[\s\S]*?\n---/.test(body)) {
      return err('body must be a SKILL.md with YAML front-matter including a description');
    }

    // Re-read rather than trust the startup snapshot: a skill may have been
    // wired into this agent since the container came up.
    const existing = readExistingSkills();
    const decision = resolveDraftKind(args.kind, name, String(args.target_skill || ''), existing);
    if ('error' in decision) return err(decision.error);
    const { kind } = decision;
    const target = decision.target ?? '';
    if (kind === 'patch' && args.kind !== 'patch') {
      log(`draft_skill: "${name}" collides with an existing skill — treating as a patch`);
    }

    writeMessageOut({
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'system',
      content: JSON.stringify({
        action: 'propose_skill',
        skill_name: kind === 'patch' ? target : name,
        body,
        kind,
        target_skill: kind === 'patch' ? target : undefined,
      }),
    });
    log(`draft_skill: "${kind === 'patch' ? target : name}" (${kind})`);
    return ok(
      kind === 'patch'
        ? `Proposed revision to "${target}" submitted for review. An admin can apply it from the room or the Skills tab. It is not live yet.`
        : `Skill draft "${name}" submitted for review. An admin can keep + wire it from the room or the Skills tab. It is not live yet.`,
    );
  },
};

registerTools([draftSkill]);

/**
 * The authoring prompt for a learning review (docs/design/learning-loop.md §2).
 *
 * Shape copied from Hermes' _SKILL_REVIEW_PROMPT, because the two quality-critical
 * parts are what stop the library filling with noise:
 *
 *   - the DENYLIST — what not to learn (environment-specific breakage, transient
 *     errors that resolved, one-off narratives). Without it every session produces
 *     a "skill".
 *   - the PREFER-EDIT hierarchy — update what exists before creating anything. The
 *     draft_skill tool enforces this (it is shown the agent's real skills and
 *     coerces a colliding 'create' into a patch), but the prompt has to ask for it
 *     too, or the model never reaches for the target.
 *
 * Written as an instruction to the agent that just did the work, in the same
 * session — so the transcript is already in context and there's no cold start.
 */
export const LEARNING_REVIEW_PROMPT = `Review THIS session and decide whether it taught you something worth keeping.

Look for a reusable, non-obvious procedure: a multi-step workflow you worked out, a fix for a tricky error, a correction the user had to make, a verification step that actually caught something.

DO NOT draft a skill for:
- environment-specific failures (a missing binary, a wrong path, a service that was down)
- transient errors that resolved on their own
- "tool X is broken" claims
- a narrative of this one task — a skill is a procedure, not a diary

If nothing here meets that bar, say so in one line and stop. A session that taught you nothing is the normal case, and an empty answer is a good answer.

If something does: call draft_skill. Prefer revising an existing skill (kind='patch') over creating a near-duplicate — you are shown the skills you already have; if the lesson belongs to one of them, patch it and pass the COMPLETE revised SKILL.md.

Write the SKILL.md as: YAML front-matter (name, and a one-line description of the capability), then — When to use / Prerequisites / Procedure (exact commands) / Pitfalls / Verification.

Never invent flags, paths, or APIs. Two sources are trustworthy: what YOU actually ran this session, and what the USER explicitly told you or corrected — a user-stated lesson is ground truth, capture it faithfully. Do not write down anything you merely inferred.

Then reply to the user in one sentence: what you drafted, or that there was nothing worth keeping.`;
