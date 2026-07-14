/**
 * Pre-import skill inspection: the inventory + lint that runs on a skill's
 * files BEFORE anything is written. The findings that must not rot:
 *   - scripts are surfaced (code that runs in agents must be visible at the
 *     moment of decision);
 *   - hidden/bidi Unicode in markdown is flagged (instruction smuggling);
 *   - official-namespace mimicry from non-official sources is flagged;
 *   - a clean instructions-only skill produces ZERO warnings — the gate must
 *     not cry wolf.
 */
import { describe, expect, it } from 'vitest';

import { inspectSkillFiles } from './inspect.js';

const md = (text: string) => ({ rel: 'SKILL.md', content: Buffer.from(text) });
const CLEAN = '---\ndescription: x\n---\nUse the tool carefully.';

describe('inspectSkillFiles', () => {
  it('a clean instructions-only skill: full inventory, zero warnings', () => {
    const r = inspectSkillFiles('tidy-skill', [md(CLEAN), { rel: 'references/notes.md', content: Buffer.from('# ok') }]);
    expect(r.warnings).toEqual([]);
    expect(r.files).toBe(2);
    expect(r.scripts).toEqual([]);
    expect(r.skillMdTokens).toBeGreaterThan(0);
    expect(r.totalBytes).toBeGreaterThan(0);
  });

  it('surfaces scripts by extension and by scripts/ dir', () => {
    const r = inspectSkillFiles('has-code', [
      md(CLEAN),
      { rel: 'helper.py', content: Buffer.from('print(1)') },
      { rel: 'scripts/run', content: Buffer.from('#!/bin/sh') },
    ]);
    expect(r.scripts).toEqual(['helper.py', 'scripts/run']);
    expect(r.warnings.some((w) => w.includes('2 scripts'))).toBe(true);
  });

  it('flags hidden zero-width/bidi Unicode in markdown, naming the file', () => {
    const r = inspectSkillFiles('sneaky', [md(`before​‮after${CLEAN}`)]);
    expect(r.warnings.some((w) => w.startsWith('SKILL.md') && w.includes('2 hidden Unicode'))).toBe(true);
    // binary files are not scanned as text
    const bin = inspectSkillFiles('img', [md(CLEAN), { rel: 'assets/logo.png', content: Buffer.from('​') }]);
    expect(bin.warnings).toEqual([]);
  });

  it('flags official-namespace mimicry unless the source is official', () => {
    const files = [md(CLEAN)];
    expect(inspectSkillFiles('anthropic-helper', files).warnings.some((w) => w.includes('mimics'))).toBe(true);
    expect(inspectSkillFiles('claude_tools', files).warnings.some((w) => w.includes('mimics'))).toBe(true);
    expect(inspectSkillFiles('anthropic-helper', files, { official: true }).warnings).toEqual([]);
    expect(inspectSkillFiles('unclaudely-named', files).warnings).toEqual([]);
  });

  it('collects external hosts from markdown, excluding github itself', () => {
    const r = inspectSkillFiles('linky', [
      md(`${CLEAN}\nSee https://example.com/docs and https://github.com/o/r plus http://api.evil.io:8080/x`),
    ]);
    expect(r.externalHosts).toEqual(['api.evil.io', 'example.com']);
  });

  it('warns on a SKILL.md that would crowd agent context', () => {
    const big = md('---\ndescription: x\n---\n' + 'lorem ipsum '.repeat(2500)); // ~30k chars ≈ 7.5k tokens
    const r = inspectSkillFiles('bloated', [big]);
    expect(r.skillMdTokens).toBeGreaterThan(5000);
    expect(r.warnings.some((w) => w.includes('crowd agent context'))).toBe(true);
  });
});
