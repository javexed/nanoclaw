import { describe, expect, it, mock, afterEach } from 'bun:test';

import { classifyWorthReviewing } from './poll-loop.js';

const CLF = { url: 'http://clf.local/v1/chat/completions', model: 'tiny' };
const MSGS = [{ content: 'set up a deploy pipeline' }] as any;

function mockFetch(answer: string, ok = true) {
  return mock(async () => ({
    ok,
    json: async () => ({ choices: [{ message: { content: answer } }] }),
  })) as unknown as typeof fetch;
}

afterEach(() => {
  // restore the real fetch
  (globalThis as any).fetch = fetchOrig;
});
const fetchOrig = globalThis.fetch;

describe('classifyWorthReviewing', () => {
  it('reviews when the model says yes', async () => {
    globalThis.fetch = mockFetch('yes');
    expect(await classifyWorthReviewing(CLF, MSGS, 6)).toBe(true);
  });

  it('skips only when the model clearly says no', async () => {
    globalThis.fetch = mockFetch('No.');
    expect(await classifyWorthReviewing(CLF, MSGS, 1)).toBe(false);
  });

  it('defaults to reviewing on an ambiguous answer (never silently drops)', async () => {
    globalThis.fetch = mockFetch('maybe, hard to say');
    expect(await classifyWorthReviewing(CLF, MSGS, 6)).toBe(true);
  });

  it('defaults to reviewing on a non-200 or thrown fetch', async () => {
    globalThis.fetch = mockFetch('no', false);
    expect(await classifyWorthReviewing(CLF, MSGS, 6)).toBe(true);
    globalThis.fetch = (() => { throw new Error('unreachable'); }) as unknown as typeof fetch;
    expect(await classifyWorthReviewing(CLF, MSGS, 6)).toBe(true);
  });
});
