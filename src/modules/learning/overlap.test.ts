/**
 * Keep-time overlap review — the heuristic layer's invariants:
 *   - the REAL twin pair this install produced (branded-pdf-deliverables vs
 *     branded-pdf-documents, staged 84 minutes apart) must clear the flag
 *     threshold — that's the incident this feature exists for;
 *   - unrelated skills must NOT flag (the gate cries wolf → gets force-clicked
 *     into irrelevance);
 *   - candidates come from scoped skills AND the pool; a patch's own target
 *     is excluded by the caller (replacing it is the point, not overlap).
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { gatherOverlapCandidates, overlapScore, OVERLAP_FLAG, OVERLAP_SHORTLIST } from './overlap.js';

const TWIN_A = {
  name: 'branded-pdf-deliverables',
  description:
    'Generate branded PDF deliverables (contracts, inspection reports, quotes) from HTML via headless chromium, and read incoming PDFs, in this workspace.',
};
const TWIN_B = {
  name: 'branded-pdf-documents',
  description:
    'Generate branded, letterhead PDF business documents (contracts, reports, warnings, quotes) via Node ESM → HTML → chromium print-to-pdf.',
};

describe('overlapScore', () => {
  it('flags the real-world twin pair this install produced', () => {
    expect(overlapScore(TWIN_A, TWIN_B)).toBeGreaterThanOrEqual(OVERLAP_FLAG);
  });

  it('does not flag unrelated skills — no crying wolf', () => {
    const other = {
      name: 'grafana-camera-over-tailscale',
      description: "Make a Grafana dashboard's LAN camera feed reachable over tailscale via a reverse proxy.",
    };
    expect(overlapScore(TWIN_A, other)).toBeLessThan(OVERLAP_SHORTLIST);
  });

  it('same-domain-different-job stays below the flag threshold', () => {
    const reader = {
      name: 'pdf-form-extraction',
      description: 'Extract form fields from uploaded PDFs into JSON using pdftk dump_data_fields.',
    };
    expect(overlapScore(TWIN_A, reader)).toBeLessThan(OVERLAP_FLAG);
  });

  it('is symmetric and bounded', () => {
    expect(overlapScore(TWIN_A, TWIN_B)).toBeCloseTo(overlapScore(TWIN_B, TWIN_A), 10);
    expect(overlapScore(TWIN_A, TWIN_A)).toBeLessThanOrEqual(1);
    expect(overlapScore(TWIN_A, { name: '', description: '' })).toBe(0);
  });
});

describe('gatherOverlapCandidates', () => {
  it('collects scoped skills from a dataDir tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overlap-'));
    const dir = path.join(root, 'v2-sessions', 'ag-x', '.claude-shared', 'skills', 'existing-skill');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: existing-skill\ndescription: does a thing\n---\n');
    const got = gatherOverlapCandidates('ag-x', 'draft-none', root);
    const scoped = got.filter((c) => c.source === 'scoped');
    expect(scoped).toEqual([{ name: 'existing-skill', description: 'does a thing', source: 'scoped' }]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
