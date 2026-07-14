import { describe, expect, it } from 'bun:test';
import { isLearnCommand } from './formatter.js';

const msg = (text: string) => ({ id: 'm', kind: 'chat', content: JSON.stringify({ text }) }) as never;

describe('isLearnCommand — the explicit trigger', () => {
  it('matches /learn, case-insensitively, with or without trailing text', () => {
    expect(isLearnCommand(msg('/learn'))).toBe(true);
    expect(isLearnCommand(msg('  /learn  '))).toBe(true);
    expect(isLearnCommand(msg('/LEARN'))).toBe(true);
    expect(isLearnCommand(msg('/learn from the CAD work'))).toBe(true);
  });

  it('does not fire on ordinary messages that merely mention learning', () => {
    expect(isLearnCommand(msg('what did you learn?'))).toBe(false);
    expect(isLearnCommand(msg('/learner'))).toBe(false); // word boundary, not prefix
    expect(isLearnCommand(msg('please /learn later'))).toBe(false);
  });
});
