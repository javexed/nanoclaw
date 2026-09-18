import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession } from '../../db/sessions.js';
import type { Session } from '../../types.js';
import './migration.js';
import { getSkillDraft, listSkillDrafts, readSkillDraftBody } from './db.js';
import { handleProposeSkill } from './request.js';
import { applySkillDraft, scopedSkillsDir } from './apply.js';
import { registerSkillDraftProposedListener, registerSkillDraftResolvedListener } from './events.js';
import { getAgentLearning, learningConfigFor, setAgentLearning } from './settings.js';

const TEST_DIR = '/tmp/nanoclaw-test-learning';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-learning' };
});

vi.mock('../../container-restart.js', () => ({
  restartAgentGroupContainers: vi.fn().mockResolvedValue(1),
}));

const BODY =
  '---\nname: rsync-backup\ndescription: Incremental backups with rsync\n---\n## Procedure\nrsync -a src/ dst/\n';

let session: Session;
const now = () => new Date().toISOString();

beforeEach(async () => {
  vi.clearAllMocks();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  session = {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  };
  await createSession(session);
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('propose_skill', () => {
  it('ignores a body without front-matter description — a SKILL.md needs one', async () => {
    await handleProposeSkill({ skill_name: 'x', body: '# no front matter' }, session);
    expect(await listSkillDrafts()).toEqual([]);
  });

  it('stages a valid draft (row + body on disk) and announces it', async () => {
    const seen: string[] = [];
    registerSkillDraftProposedListener((e) => seen.push(`${e.skillName}:${e.kind}:${e.agentName}`));
    await handleProposeSkill({ skill_name: 'Rsync Backup!', body: BODY }, session);
    const [d] = await listSkillDrafts('ag-1');
    expect(d.skill_name).toBe('rsync-backup'); // sanitized
    expect(d.description).toBe('Incremental backups with rsync');
    expect(d.status).toBe('pending');
    expect(readSkillDraftBody(d.id)).toBe(BODY);
    expect(seen).toEqual(['rsync-backup:create:Agent']);
  });

  it('a newer draft of the same name supersedes the pending one', async () => {
    const resolved: string[] = [];
    registerSkillDraftResolvedListener((e) => resolved.push(`${e.outcome}:${e.by}`));
    await handleProposeSkill({ skill_name: 'rsync-backup', body: BODY }, session);
    const [first] = await listSkillDrafts('ag-1');
    await handleProposeSkill({ skill_name: 'rsync-backup', body: BODY.replace('rsync -a', 'rsync -az') }, session);
    const pending = await listSkillDrafts('ag-1');
    expect(pending).toHaveLength(1);
    expect(pending[0].id).not.toBe(first.id);
    expect(await getSkillDraft(first.id)).toBeUndefined();
    expect(resolved).toEqual(['discarded:superseded']);
  });
});

describe('Keep (applySkillDraft)', () => {
  it('writes the skill into the agent scoped dir, stamps provenance, resolves the draft, restarts', async () => {
    await handleProposeSkill({ skill_name: 'rsync-backup', body: BODY }, session);
    const [d] = await listSkillDrafts('ag-1');
    const r = await applySkillDraft(d, 'test keep');
    expect(r.ok).toBe(true);
    expect(r.name).toBe('rsync-backup');
    const dir = path.join(scopedSkillsDir('ag-1'), 'rsync-backup');
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toBe(BODY);
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.origin.json'), 'utf8'))).toEqual({
      label: 'learned',
      official: false,
    });
    expect(await getSkillDraft(d.id)).toBeUndefined();
    expect(fs.existsSync(path.join(TEST_DIR, 'skill-drafts', d.id))).toBe(false);
    const { restartAgentGroupContainers } = await import('../../container-restart.js');
    expect(restartAgentGroupContainers).toHaveBeenCalledWith('ag-1', 'test keep');
  });

  it('a patch replaces its target but keeps the original provenance', async () => {
    const dir = path.join(scopedSkillsDir('ag-1'), 'rsync-backup');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), BODY);
    fs.writeFileSync(path.join(dir, '.origin.json'), JSON.stringify({ label: 'obra/superpowers', official: true }));
    await handleProposeSkill(
      { skill_name: 'rsync-backup', kind: 'patch', target_skill: 'rsync-backup', body: BODY.replace('-a ', '-az ') },
      session,
    );
    const [d] = await listSkillDrafts('ag-1');
    const r = await applySkillDraft(d, 'test patch');
    expect(r.ok && r.patched).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toContain('rsync -az');
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.origin.json'), 'utf8')).label).toBe('obra/superpowers');
  });
});

describe('auto-learn setting', () => {
  it('defaults on, persists off, and rides into the container config', async () => {
    expect(await getAgentLearning('ag-1')).toEqual({ autoTrigger: true, cooldownMinutes: 30 });
    expect(await learningConfigFor('ag-1')).toEqual({ autoTrigger: true, cooldownMinutes: 30 });
    await setAgentLearning('ag-1', { autoTrigger: false, cooldownMinutes: 5 });
    expect(await getAgentLearning('ag-1')).toEqual({ autoTrigger: false, cooldownMinutes: 5 });
    expect(await learningConfigFor('ag-1')).toEqual({ autoTrigger: false, cooldownMinutes: 5 });
  });
  it('clamps the cooldown to a sane range', async () => {
    expect((await setAgentLearning('ag-1', { cooldownMinutes: 0 })).cooldownMinutes).toBe(1);
    expect((await setAgentLearning('ag-1', { cooldownMinutes: 99_999 })).cooldownMinutes).toBe(24 * 60);
  });
});
