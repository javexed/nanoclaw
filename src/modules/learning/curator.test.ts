/**
 * The curator sweep (learning loop §6): age scoped skills by USE, archive the
 * stale ones, never delete, always restorable.
 *
 * The invariants that must not rot:
 *   - staleness is driven by last-INVOCATION (the .last-invoked stamp), not
 *     creation date — a two-year-old skill used yesterday is not stale;
 *   - threshold ≤ 0 disables the curator outright;
 *   - archiving MOVES (the content survives); restore refuses to clobber a
 *     re-learned live skill; restoring resets the clock (else the next sweep
 *     re-archives it a day later).
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ARCHIVE_DIR, decideStale, restoreArchivedSkill, skillLastUsedAt } from './curator.js';

const DAY = 24 * 60 * 60 * 1000;

describe('decideStale', () => {
  const now = 1_800_000_000_000;
  it('archives only what has gone unused past the threshold', () => {
    const stale = decideStale(
      [
        { name: 'fresh', lastUsedAt: now - 5 * DAY },
        { name: 'old-but-used', lastUsedAt: now - 89 * DAY },
        { name: 'stale', lastUsedAt: now - 91 * DAY },
      ],
      now,
      90,
    );
    expect(stale).toEqual(['stale']);
  });

  it('threshold ≤ 0 turns the curator off — nothing is ever stale', () => {
    expect(decideStale([{ name: 'ancient', lastUsedAt: 0 }], now, 0)).toEqual([]);
    expect(decideStale([{ name: 'ancient', lastUsedAt: 0 }], now, -1)).toEqual([]);
  });
});

describe('skillLastUsedAt', () => {
  it('prefers the .last-invoked stamp over SKILL.md mtime — use beats age', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-'));
    const skill = path.join(dir, 's');
    fs.mkdirSync(skill);
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\ndescription: x\n---\n');
    const old = Date.now() - 100 * DAY;
    fs.utimesSync(path.join(skill, 'SKILL.md'), old / 1000, old / 1000);
    // no stamp → ages from the (old) mtime
    expect(skillLastUsedAt(skill)!).toBeLessThan(Date.now() - 99 * DAY);
    // stamped yesterday → young again
    fs.writeFileSync(path.join(skill, '.last-invoked'), new Date(Date.now() - DAY).toISOString());
    expect(skillLastUsedAt(skill)!).toBeGreaterThan(Date.now() - 2 * DAY);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null for a dir with no SKILL.md (not a skill)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-'));
    expect(skillLastUsedAt(dir)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('restoreArchivedSkill', () => {
  function makeAgent(): { root: string; skillsDir: string; groupId: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-data-'));
    const groupId = 'ag-test';
    const skillsDir = path.join(root, 'v2-sessions', groupId, '.claude-shared', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    return { root, skillsDir, groupId };
  }

  it('moves an archived skill back, content intact, and stamps it as used', () => {
    const { root, skillsDir, groupId } = makeAgent();
    const arch = path.join(skillsDir, ARCHIVE_DIR, 'dormant');
    fs.mkdirSync(arch, { recursive: true });
    fs.writeFileSync(path.join(arch, 'SKILL.md'), '---\ndescription: kept safe\n---\nbody');

    const r = restoreArchivedSkill(groupId, 'dormant', root);
    expect(r.ok).toBe(true);
    const restored = path.join(skillsDir, 'dormant');
    expect(fs.readFileSync(path.join(restored, 'SKILL.md'), 'utf8')).toContain('kept safe');
    // the restore itself is a use signal — the clock resets
    const stamp = Date.parse(fs.readFileSync(path.join(restored, '.last-invoked'), 'utf8'));
    expect(Date.now() - stamp).toBeLessThan(60_000);
    expect(fs.existsSync(arch)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses to clobber a live skill re-learned since archiving', () => {
    const { root, skillsDir, groupId } = makeAgent();
    fs.mkdirSync(path.join(skillsDir, ARCHIVE_DIR, 'dup'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, ARCHIVE_DIR, 'dup', 'SKILL.md'), 'old');
    fs.mkdirSync(path.join(skillsDir, 'dup'));
    fs.writeFileSync(path.join(skillsDir, 'dup', 'SKILL.md'), 'new');

    const r = restoreArchivedSkill(groupId, 'dup', root);
    expect(r.ok).toBe(false);
    // both copies still exist — nothing lost either way
    expect(fs.readFileSync(path.join(skillsDir, 'dup', 'SKILL.md'), 'utf8')).toBe('new');
    expect(fs.readFileSync(path.join(skillsDir, ARCHIVE_DIR, 'dup', 'SKILL.md'), 'utf8')).toBe('old');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
