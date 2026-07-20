/**
 * applySkillDraft — the "update existing skill" path.
 *
 * The webchat overlap review's "Update <skill>" choice re-types a create-draft
 * as a patch of the chosen skill and applies it. The contract that makes that
 * safe: a patch REPLACES the target's SKILL.md and snapshots the outgoing
 * version into .history/<name>/ first, so a bad update is recoverable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const { DATA, draftBody } = vi.hoisted(() => ({
  DATA: '/tmp/apply-test-' + process.pid,
  draftBody: { value: '' },
}));

vi.mock('../../config.js', () => ({ DATA_DIR: DATA }));
vi.mock('../../container-restart.js', () => ({ restartAgentGroupContainers: () => 0 }));
vi.mock('../../db/skill-drafts.js', () => ({
  readSkillDraftBody: () => draftBody.value,
  resolveSkillDraft: () => {},
}));

const { applySkillDraft } = await import('./apply.js');

const AG = 'ag-apply-test';
const scoped = path.join(DATA, 'v2-sessions', AG, '.claude-shared', 'skills');

beforeEach(() => {
  fs.mkdirSync(path.join(scoped, 'existing-skill'), { recursive: true });
  fs.writeFileSync(path.join(scoped, 'existing-skill', 'SKILL.md'), 'OLD CONTENT');
  draftBody.value = 'NEW CONTENT';
});
afterEach(() => fs.rmSync(DATA, { recursive: true, force: true }));

describe('applySkillDraft — update existing skill (patch)', () => {
  it('replaces the target skill and snapshots the old version to .history', () => {
    // A create-draft re-typed as a patch of an existing skill — exactly what the
    // keep handler does for an "Update <skill>" overlap choice.
    const draft = {
      id: 'd1',
      agent_group_id: AG,
      kind: 'patch' as const,
      target_skill: 'existing-skill',
      skill_name: 'newly-learned',
    };
    const r = applySkillDraft(draft as Parameters<typeof applySkillDraft>[0], 'test update');

    expect(r.ok).toBe(true);
    expect(r.name).toBe('existing-skill'); // wrote to the TARGET, not the draft's own name
    expect(r.patched).toBe(true);
    // Target body replaced with the draft body.
    expect(fs.readFileSync(path.join(scoped, 'existing-skill', 'SKILL.md'), 'utf8')).toBe('NEW CONTENT');
    // Old body preserved under .history/<name>/<ts>/ (recoverable).
    const histRoot = path.join(scoped, '.history', 'existing-skill');
    const snaps = fs.readdirSync(histRoot);
    expect(snaps).toHaveLength(1);
    expect(fs.readFileSync(path.join(histRoot, snaps[0], 'SKILL.md'), 'utf8')).toBe('OLD CONTENT');
  });

  it('does not touch a differently-named skill (the draft name is ignored on a patch)', () => {
    const draft = {
      id: 'd2',
      agent_group_id: AG,
      kind: 'patch' as const,
      target_skill: 'existing-skill',
      skill_name: 'newly-learned',
    };
    applySkillDraft(draft as Parameters<typeof applySkillDraft>[0], 'test update');
    // No skill created under the draft's own name.
    expect(fs.existsSync(path.join(scoped, 'newly-learned'))).toBe(false);
  });
});
