/**
 * Revision history for patched skills (learning loop): a patch REPLACES its
 * target, and with auto-keep on a bad revision would otherwise be gone. The
 * invariants:
 *   - snapshots land under .history/<name>/<ts>/ (dot-prefixed — skill
 *     scanners must skip it);
 *   - revert restores the newest snapshot AND snapshots the outgoing version
 *     first, so a revert is itself revertible — history never destroys;
 *   - no history / no skill → clean refusal, nothing touched.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { listRevisions, revertLastRevision, snapshotRevision } from './apply.js';

function makeSkill(body: string): { dir: string; skill: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-'));
  const skill = path.join(dir, 's');
  fs.mkdirSync(skill);
  fs.writeFileSync(path.join(skill, 'SKILL.md'), body);
  return { dir, skill };
}

describe('snapshotRevision / listRevisions', () => {
  it('snapshots the current version into .history and lists newest-first', async () => {
    const { dir, skill } = makeSkill('v1');
    snapshotRevision(dir, 's');
    await new Promise((r) => setTimeout(r, 5)); // distinct Date.now() dirs
    fs.writeFileSync(path.join(skill, 'SKILL.md'), 'v2');
    snapshotRevision(dir, 's');

    const revs = listRevisions(dir, 's');
    expect(revs).toHaveLength(2);
    expect(revs[0]).toBeGreaterThan(revs[1]);
    const newest = path.join(dir, '.history', 's', String(revs[0]));
    expect(fs.readFileSync(path.join(newest, 'SKILL.md'), 'utf8')).toBe('v2');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists nothing for a never-revised skill', () => {
    const { dir } = makeSkill('v1');
    expect(listRevisions(dir, 's')).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('revertLastRevision', () => {
  it('restores the newest snapshot and keeps the reverted-away version revertible', async () => {
    const { dir, skill } = makeSkill('v1');
    snapshotRevision(dir, 's'); // history: [v1]
    await new Promise((r) => setTimeout(r, 5));
    fs.writeFileSync(path.join(skill, 'SKILL.md'), 'v2'); // live: v2

    const r = revertLastRevision(dir, 's');
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8')).toBe('v1');
    // v2 went INTO history on the way out — revert the revert:
    const r2 = revertLastRevision(dir, 's');
    expect(r2.ok).toBe(true);
    expect(fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8')).toBe('v2');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses cleanly with no history or no live skill', () => {
    const { dir, skill } = makeSkill('v1');
    expect(revertLastRevision(dir, 's').ok).toBe(false); // no history
    snapshotRevision(dir, 's');
    fs.rmSync(skill, { recursive: true, force: true });
    expect(revertLastRevision(dir, 's').ok).toBe(false); // no live skill
    // and the snapshot survived the refusal
    expect(listRevisions(dir, 's')).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
