import { describe, expect, test } from 'bun:test';

import { summarizeThinking } from './claude.js';

describe('summarizeThinking', () => {
  test('splits on newlines, strips markdown noise, drops empties', () => {
    const out = summarizeThinking('# Plan\n\n- Read the file\n\n> then edit it');
    expect(out).toEqual(['Plan', 'Read the file', 'then edit it']);
  });

  test('keeps only the last N lines (the conclusion)', () => {
    const many = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const out = summarizeThinking(many);
    expect(out).toHaveLength(8);
    expect(out[0]).toBe('line 12');
    expect(out[7]).toBe('line 19');
  });

  test('truncates a very long line with an ellipsis', () => {
    const long = 'x'.repeat(500);
    const out = summarizeThinking(long);
    expect(out).toHaveLength(1);
    expect(out[0].length).toBe(200);
    expect(out[0].endsWith('…')).toBe(true);
  });

  test('empty / whitespace-only thinking yields nothing', () => {
    expect(summarizeThinking('')).toEqual([]);
    expect(summarizeThinking('\n\n   \n')).toEqual([]);
  });
});
