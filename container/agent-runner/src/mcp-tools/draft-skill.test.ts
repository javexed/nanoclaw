import { describe, expect, it } from 'bun:test';

import { buildDescription, resolveDraftKind, skillDescription } from './draft-skill.js';

const existing = [
  { name: 'deploy-rollout', description: 'Roll out a deploy safely' },
  { name: 'pdf-export', description: 'Export branded PDFs' },
];

describe('resolveDraftKind — update before create, enforced', () => {
  it('a patch needs a target', () => {
    expect(resolveDraftKind('patch', 'x', '', existing)).toEqual({
      error: "kind='patch' requires target_skill (the exact name of the skill you're revising)",
    });
  });
  it('a patch at an unknown target is rejected with the real names', () => {
    const r = resolveDraftKind('patch', 'x', 'nope', existing) as { error: string };
    expect(r.error).toContain('deploy-rollout, pdf-export');
  });
  it('a create that collides with an existing skill is coerced into a patch', () => {
    expect(resolveDraftKind('create', 'pdf-export', '', existing)).toEqual({ kind: 'patch', target: 'pdf-export' });
  });
  it('a genuinely new name creates', () => {
    expect(resolveDraftKind('create', 'brand-new', '', existing)).toEqual({ kind: 'create' });
  });
});

describe('skill front-matter', () => {
  it('reads a quoted or bare description', () => {
    expect(skillDescription('---\nname: a\ndescription: "Do the thing"\n---\nbody')).toBe('Do the thing');
    expect(skillDescription('---\ndescription: bare\n---')).toBe('bare');
    expect(skillDescription('no front matter')).toBe('');
  });
  it('the tool description lists what the agent already has', () => {
    expect(buildDescription([])).not.toContain('UPDATE BEFORE CREATE');
    const d = buildDescription(existing);
    expect(d).toContain('UPDATE BEFORE CREATE');
    expect(d).toContain('- deploy-rollout: Roll out a deploy safely');
  });
});
