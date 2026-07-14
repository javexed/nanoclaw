/**
 * Regression: a single unclosed `{` in style.css silently kills every rule after it.
 *
 * The setup-wizard commit left a stray, declaration-less `.wizard-list {` with no
 * closing brace. CSS has no "error" — the parser just swallows everything that
 * follows into the unterminated block. 607 lines / 89 rule-blocks (the router
 * picker, the slash menu, the wizard list's own li/label styles) were dead on the
 * live install for two days and nothing failed: no build error, no test, no
 * console warning. The only symptom was "my new CSS isn't applying."
 *
 * Cheap structural check, and the only thing standing between us and a silent
 * repeat.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CSS = path.join(here, '../../../public/webchat/style.css');

/** Strip comments and quoted strings so braces inside them don't skew the count. */
function stripNoise(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
}

describe('webchat style.css integrity', () => {
  const css = stripNoise(fs.readFileSync(CSS, 'utf8'));

  it('has balanced braces — an unclosed block silently voids every rule after it', () => {
    const opens = (css.match(/\{/g) || []).length;
    const closes = (css.match(/\}/g) || []).length;
    expect(closes - opens).toBe(0);
  });

  it('never goes brace-negative (a stray } would end a block early)', () => {
    let depth = 0;
    for (const ch of css) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
  });

  it('has no declaration-less selector immediately followed by another selector', () => {
    // The exact shape of the bug: `.foo {` with nothing but a selector after it.
    const offenders: string[] = [];
    const lines = css.split('\n');
    for (let i = 0; i < lines.length - 1; i++) {
      const cur = lines[i].trim();
      // An at-rule block (@media, @supports, @layer) legitimately opens with a
      // selector on the very next line — that's nesting, not the bug.
      if (!/\{$/.test(cur) || cur.startsWith('@')) continue;
      const next = lines[i + 1].trim();
      if (next && /\{$/.test(next) && !next.startsWith('@')) {
        offenders.push(`line ${i + 1}: ${cur} -> ${next}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
