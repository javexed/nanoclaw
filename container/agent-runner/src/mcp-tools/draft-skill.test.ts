/**
 * The update-before-create hierarchy.
 *
 * A learning loop that only ever CREATES fills the library with near-duplicates:
 * the same lesson re-learned and re-filed under a slightly different name every
 * time it comes up. Two things prevent that, and both are tested here:
 *
 *   1. the agent is shown the skills it actually has (it can't avoid duplicating
 *      what it can't see), and
 *   2. the hierarchy is ENFORCED, not suggested — a 'create' that collides with an
 *      existing skill is coerced into a revision of it.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildDescription,
  LEARNING_REVIEW_PROMPT,
  readExistingSkills,
  resolveDraftKind,
  skillDescription,
  type ExistingSkill,
} from './draft-skill.js';

const SKILLS: ExistingSkill[] = [
  { name: 'matched-lean-mating-faces', description: 'Give every mating part the same lean.' },
  { name: 'tidy-csv-export', description: 'Export a clean CSV.' },
];

describe('skillDescription', () => {
  it('pulls description out of front-matter', () => {
    expect(skillDescription('---\nname: x\ndescription: Does a thing.\n---\n# X')).toBe('Does a thing.');
  });
  it('strips quotes and tolerates a missing description', () => {
    expect(skillDescription('---\ndescription: "Quoted."\n---\n')).toBe('Quoted.');
    expect(skillDescription('# no front-matter')).toBe('');
  });
});

describe('readExistingSkills', () => {
  it('reads real dirs (scoped) and skips entries without a SKILL.md', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
    fs.mkdirSync(path.join(dir, 'alpha'));
    fs.writeFileSync(path.join(dir, 'alpha', 'SKILL.md'), '---\ndescription: Alpha does A.\n---\n');
    fs.mkdirSync(path.join(dir, 'not-a-skill')); // no SKILL.md
    const got = readExistingSkills(dir);
    expect(got).toEqual([{ name: 'alpha', description: 'Alpha does A.' }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns [] for a missing directory rather than throwing', () => {
    expect(readExistingSkills('/definitely/not/here')).toEqual([]);
  });
});

describe('buildDescription', () => {
  it('lists the skills the agent actually has, so it can match against real names', () => {
    const d = buildDescription(SKILLS);
    expect(d).toContain('UPDATE BEFORE CREATE');
    expect(d).toContain('matched-lean-mating-faces');
    expect(d).toContain('tidy-csv-export');
    // The descriptions matter as much as the names — that's what the model matches on.
    expect(d).toContain('Give every mating part the same lean.');
    // A patch must carry the WHOLE revised file; a fragment or a diff can't be applied.
    expect(d).toContain('COMPLETE revised SKILL.md');
  });

  it('says nothing about patching when there is nothing to patch', () => {
    const d = buildDescription([]);
    expect(d).not.toContain('UPDATE BEFORE CREATE');
  });
});

describe('resolveDraftKind — the hierarchy, enforced', () => {
  it('coerces a create that collides with an existing skill into a patch of it', () => {
    // The whole point: re-learning a lesson must refine, not duplicate.
    expect(resolveDraftKind('create', 'tidy-csv-export', '', SKILLS)).toEqual({
      kind: 'patch',
      target: 'tidy-csv-export',
    });
  });

  it('creates when nothing existing covers it', () => {
    expect(resolveDraftKind('create', 'brand-new-thing', '', SKILLS)).toEqual({ kind: 'create' });
  });

  it('accepts a patch at a real target', () => {
    expect(resolveDraftKind('patch', 'whatever', 'matched-lean-mating-faces', SKILLS)).toEqual({
      kind: 'patch',
      target: 'matched-lean-mating-faces',
    });
  });

  it('rejects a patch at a target that does not exist, naming the real ones', () => {
    const r = resolveDraftKind('patch', 'x', 'imagined-skill', SKILLS);
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toContain('imagined-skill');
    expect((r as { error: string }).error).toContain('tidy-csv-export');
  });

  it('rejects a patch with no target', () => {
    expect(resolveDraftKind('patch', 'x', '', SKILLS)).toHaveProperty('error');
  });

  it('with no skills at all, everything is a create', () => {
    expect(resolveDraftKind('create', 'anything', '', [])).toEqual({ kind: 'create' });
  });
});

describe('LEARNING_REVIEW_PROMPT — the two quality-critical parts', () => {
  it('carries the denylist (without it every session yields a "skill")', () => {
    expect(LEARNING_REVIEW_PROMPT).toContain('DO NOT draft a skill for');
    expect(LEARNING_REVIEW_PROMPT).toContain('environment-specific failures');
    expect(LEARNING_REVIEW_PROMPT).toContain('transient errors that resolved');
  });

  it('asks for update-before-create, and for the COMPLETE file on a patch', () => {
    expect(LEARNING_REVIEW_PROMPT).toContain("kind='patch'");
    expect(LEARNING_REVIEW_PROMPT).toContain('COMPLETE revised SKILL.md');
  });

  it('makes "nothing worth keeping" an acceptable answer', () => {
    // The failure mode of a learning loop is inventing lessons to look useful.
    expect(LEARNING_REVIEW_PROMPT).toContain('an empty answer is a good answer');
  });

  it('forbids inventing, but treats user-stated lessons as ground truth', () => {
    expect(LEARNING_REVIEW_PROMPT).toContain('Never invent flags, paths, or APIs');
    // Found live: the earlier wording ("if you did not run it, do not write it
    // down") made the agent refuse a lesson the USER explicitly dictated. A
    // user-stated correction is a trigger in the design, not fabrication.
    expect(LEARNING_REVIEW_PROMPT).toContain('user-stated lesson is ground truth');
  });
});
