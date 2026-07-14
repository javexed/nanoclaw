/**
 * Cross-agent duplicate detection + promotion (learning loop): the same skill
 * name learned independently on 2+ agents is the signal a lesson belongs in
 * the shared pool. Invariants:
 *   - detection needs ≥2 holders; symlinks (pooled) and dot-dirs don't count;
 *   - the NEWEST copy wins promotion;
 *   - promotion ARCHIVES each agent's copy (never deletes) and refuses to
 *     clobber an existing pool entry.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ARCHIVE_DIR, findDuplicateScopedSkills, promoteScopedSkill } from './curator.js';

function makeInstall(): { root: string; pool: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dups-data-'));
  const pool = fs.mkdtempSync(path.join(os.tmpdir(), 'dups-pool-'));
  return { root, pool };
}

function addSkill(root: string, agent: string, name: string, body: string, mtimeMs?: number): string {
  const dir = path.join(root, 'v2-sessions', agent, '.claude-shared', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  const md = path.join(dir, 'SKILL.md');
  fs.writeFileSync(md, body);
  if (mtimeMs) fs.utimesSync(md, mtimeMs / 1000, mtimeMs / 1000);
  return dir;
}

describe('findDuplicateScopedSkills', () => {
  it('finds names held by 2+ agents, newest copy first', () => {
    const { root } = makeInstall();
    const old = Date.now() - 1_000_000;
    addSkill(root, 'ag-a', 'shared-lesson', 'newer', Date.now() - 1000);
    addSkill(root, 'ag-b', 'shared-lesson', 'older', old);
    addSkill(root, 'ag-a', 'solo-lesson', 'x');

    const dups = findDuplicateScopedSkills(root);
    expect(dups).toHaveLength(1);
    expect(dups[0].name).toBe('shared-lesson');
    expect(dups[0].newestAgent).toBe('ag-a');
    expect(dups[0].agents).toEqual(['ag-a', 'ag-b']);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('empty for a fresh install and ignores dot-dirs', () => {
    const { root } = makeInstall();
    expect(findDuplicateScopedSkills(root)).toEqual([]);
    addSkill(root, 'ag-a', 'x', '1');
    fs.mkdirSync(path.join(root, 'v2-sessions', 'ag-b', '.claude-shared', 'skills', '.archive', 'x'), {
      recursive: true,
    });
    expect(findDuplicateScopedSkills(root)).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('promoteScopedSkill', () => {
  it('pools the newest copy and archives every agent copy — nothing deleted', () => {
    const { root, pool } = makeInstall();
    addSkill(root, 'ag-a', 'lesson', 'NEWEST', Date.now() - 1000);
    addSkill(root, 'ag-b', 'lesson', 'older', Date.now() - 1_000_000);

    const r = promoteScopedSkill('lesson', root, pool);
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(pool, 'lesson', 'SKILL.md'), 'utf8')).toBe('NEWEST');
    for (const [agent, body] of [
      ['ag-a', 'NEWEST'],
      ['ag-b', 'older'],
    ]) {
      const skills = path.join(root, 'v2-sessions', agent, '.claude-shared', 'skills');
      expect(fs.existsSync(path.join(skills, 'lesson'))).toBe(false);
      expect(fs.readFileSync(path.join(skills, ARCHIVE_DIR, 'lesson', 'SKILL.md'), 'utf8')).toBe(body);
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(pool, { recursive: true, force: true });
  });

  it('refuses a non-duplicate and an existing pool entry', () => {
    const { root, pool } = makeInstall();
    addSkill(root, 'ag-a', 'solo', 'x');
    expect(promoteScopedSkill('solo', root, pool).ok).toBe(false);

    addSkill(root, 'ag-b', 'solo', 'y');
    fs.mkdirSync(path.join(pool, 'solo'), { recursive: true });
    const r = promoteScopedSkill('solo', root, pool);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/pool/i);
    // both scoped copies untouched by the refusal
    expect(fs.existsSync(path.join(root, 'v2-sessions', 'ag-a', '.claude-shared', 'skills', 'solo'))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(pool, { recursive: true, force: true });
  });
});
