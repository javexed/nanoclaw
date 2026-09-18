import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { OVERLAP_FLAG, OVERLAP_SHORTLIST, gatherOverlapCandidates, overlapScore } from './overlap.js';

describe('overlapScore', () => {
  it('flags an identical skill', () => {
    const a = { name: 'branded-pdf-export', description: 'Export a branded PDF report from the estimator' };
    expect(overlapScore(a, a)).toBeGreaterThanOrEqual(OVERLAP_FLAG);
  });
  it('catches sibling-name twins the exact-name dedup cannot', () => {
    const a = { name: 'branded-pdf-deliverables', description: 'Produce branded PDF deliverables for a client' };
    const b = { name: 'branded-pdf-documents', description: 'Generate branded PDF documents for clients' };
    expect(overlapScore(a, b)).toBeGreaterThanOrEqual(OVERLAP_SHORTLIST);
  });
  it('is zero for unrelated skills', () => {
    const a = { name: 'rsync-backup', description: 'Incremental backups with rsync' };
    const b = { name: 'oauth-refresh', description: 'Refresh an expiring OAuth token' };
    expect(overlapScore(a, b)).toBe(0);
  });
});

describe('gatherOverlapCandidates', () => {
  it('sees the agent scoped skills', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-'));
    const skills = path.join(dataDir, 'v2-sessions', 'ag-1', '.claude-shared', 'skills');
    fs.mkdirSync(path.join(skills, 'rsync-backup'), { recursive: true });
    fs.writeFileSync(
      path.join(skills, 'rsync-backup', 'SKILL.md'),
      '---\nname: rsync-backup\ndescription: Incremental backups with rsync\n---\n',
    );
    fs.mkdirSync(path.join(skills, '.archive', 'old'), { recursive: true }); // dot-prefixed = skipped
    const out = await gatherOverlapCandidates('ag-1', 'draft-x', dataDir);
    expect(out.find((c) => c.name === 'rsync-backup')?.source).toBe('scoped');
    expect(out.find((c) => c.name === '.archive')).toBeUndefined();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});
