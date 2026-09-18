import { describe, expect, it } from 'bun:test';

import { LEARNING_REVIEW_PROMPT } from './mcp-tools/draft-skill.js';
import {
  AUTO_REVIEW_MIN_TOOLS,
  DIGEST_MAX_CHARS,
  DIGEST_MAX_EXCHANGES,
  buildLearnReviewPrompt,
  buildReviewDigest,
  createExchangeLog,
  isLearnCommand,
  learningReviewQueryOptions,
  recordExchange,
  shouldAutoReview,
  truncateMiddle,
} from './learning-loop.js';

const base = {
  learning: undefined,
  supportsRestrictedReview: true,
  toolCount: AUTO_REVIEW_MIN_TOOLS,
  hadLearnCommand: false,
  lastAutoReviewAt: null,
  now: 1_000_000,
};

describe('shouldAutoReview', () => {
  it('fires on a busy turn with defaults', () => {
    expect(shouldAutoReview(base)).toBe(true);
  });
  it('needs the busy-turn threshold', () => {
    expect(shouldAutoReview({ ...base, toolCount: AUTO_REVIEW_MIN_TOOLS - 1 })).toBe(false);
  });
  it('respects the per-agent switch', () => {
    expect(shouldAutoReview({ ...base, learning: { autoTrigger: false } })).toBe(false);
  });
  it('never runs without a restricted pass — nobody is watching an auto review', () => {
    expect(shouldAutoReview({ ...base, supportsRestrictedReview: false })).toBe(false);
  });
  it('a turn that was itself /learn does not re-trigger', () => {
    expect(shouldAutoReview({ ...base, hadLearnCommand: true })).toBe(false);
  });
  it('honours the cooldown, default 30 min', () => {
    const t = base.now;
    expect(shouldAutoReview({ ...base, lastAutoReviewAt: t - 29 * 60_000 })).toBe(false);
    expect(shouldAutoReview({ ...base, lastAutoReviewAt: t - 31 * 60_000 })).toBe(true);
    expect(shouldAutoReview({ ...base, learning: { cooldownMinutes: 5 }, lastAutoReviewAt: t - 6 * 60_000 })).toBe(true);
  });
});

describe('exchange digest', () => {
  it('is null when nothing was recorded', () => {
    expect(buildReviewDigest(createExchangeLog())).toBeNull();
  });
  it('retains only the most recent exchanges', () => {
    const log = createExchangeLog();
    for (let i = 0; i < DIGEST_MAX_EXCHANGES + 5; i++) recordExchange(log, { prompt: `p${i}`, result: `r${i}` });
    expect(log.entries.length).toBe(DIGEST_MAX_EXCHANGES);
    expect(log.entries[0].prompt).toBe('p5');
  });
  it('holds the total budget and keeps the newest when over it', () => {
    const log = createExchangeLog();
    const big = 'x'.repeat(5_000);
    for (let i = 0; i < DIGEST_MAX_EXCHANGES; i++) recordExchange(log, { prompt: `${i}:${big}`, result: big });
    const d = buildReviewDigest(log)!;
    expect(d.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    expect(d).toContain(`${DIGEST_MAX_EXCHANGES - 1}:`);
  });
  it('truncateMiddle keeps head and tail', () => {
    const t = truncateMiddle('A'.repeat(100) + 'B'.repeat(100), 80);
    expect(t.startsWith('A')).toBe(true);
    expect(t.endsWith('B')).toBe(true);
    expect(t).toContain('truncated');
    expect(t.length).toBeLessThanOrEqual(80);
  });
});

describe('/learn', () => {
  it('matches the command and nothing else', () => {
    expect(isLearnCommand('/learn')).toBe(true);
    expect(isLearnCommand('  /LEARN keep the rsync part')).toBe(true);
    expect(isLearnCommand('/learning')).toBe(false);
    expect(isLearnCommand('please /learn this')).toBe(false);
  });
  it('a bare /learn is the authoring prompt; a hint is folded in as steering', () => {
    expect(buildLearnReviewPrompt('/learn')).toBe(LEARNING_REVIEW_PROMPT);
    const p = buildLearnReviewPrompt('/learn keep the rsync part');
    expect(p.startsWith(LEARNING_REVIEW_PROMPT)).toBe(true);
    expect(p).toContain('keep the rsync part');
  });
});

describe('learningReviewQueryOptions', () => {
  const input = { prompt: 'x', cwd: '/w' };
  it('contributes nothing to an ordinary turn', () => {
    expect(learningReviewQueryOptions(input)).toBeNull();
  });
  it('restricts a review to draft_skill and forks only when there is a continuation', () => {
    const r = learningReviewQueryOptions({ ...input, moduleInput: { learningReview: true } })!;
    expect(r.allowedTools).toEqual(['mcp__nanoclaw__draft_skill']);
    expect(r.forkSession).toBeUndefined();
    const f = learningReviewQueryOptions({ ...input, continuation: 'c1', moduleInput: { learningReview: true } })!;
    expect(f.forkSession).toBe(true);
  });
  it('a configured review model wins', () => {
    const r = learningReviewQueryOptions({ ...input, moduleInput: { learningReview: true, reviewModel: 'haiku' } })!;
    expect(r.model).toBe('haiku');
  });
});
