/**
 * The auto-trigger decision (docs/webchat/learning-loop.md §1).
 *
 * Auto mode runs a review with nobody watching, so the guards ARE the feature:
 * cost (threshold + cooldown), noise (a /learn turn never re-triggers), and
 * safety (never fall back to the unrestricted in-turn review — that fallback
 * exists for a human who asked, not for an automation nobody is watching).
 */
import { describe, expect, it } from 'bun:test';
import { AUTO_REVIEW_MIN_TOOLS, resolveRoomLearning, shouldAutoReview } from './learning-loop.js';

const base = {
  learning: undefined as { autoTrigger?: boolean; cooldownMinutes?: number } | undefined,
  supportsRestrictedReview: true,
  toolCount: AUTO_REVIEW_MIN_TOOLS,
  hadLearnCommand: false,
  lastAutoReviewAt: null as number | null,
  now: 1_800_000_000_000,
};

describe('shouldAutoReview', () => {
  it('defaults ON: absent config + a busy turn triggers', () => {
    expect(shouldAutoReview({ ...base })).toBe(true);
  });

  it('explicit autoTrigger:false turns it off', () => {
    expect(shouldAutoReview({ ...base, learning: { autoTrigger: false } })).toBe(false);
  });

  it('quiet turns never trigger', () => {
    expect(shouldAutoReview({ ...base, toolCount: AUTO_REVIEW_MIN_TOOLS - 1 })).toBe(false);
    expect(shouldAutoReview({ ...base, toolCount: 0 })).toBe(false);
  });

  it('a turn that was itself /learn never re-triggers', () => {
    expect(shouldAutoReview({ ...base, hadLearnCommand: true })).toBe(false);
  });

  it('never falls back to the unrestricted in-turn review', () => {
    // The fallback is for a human who asked; auto mode has nobody watching it.
    expect(shouldAutoReview({ ...base, supportsRestrictedReview: false })).toBe(false);
  });

  it('cooldown bounds spend on chatty rooms (default 30 min)', () => {
    const justRan = base.now - 10 * 60_000;
    expect(shouldAutoReview({ ...base, lastAutoReviewAt: justRan })).toBe(false);
    const longAgo = base.now - 31 * 60_000;
    expect(shouldAutoReview({ ...base, lastAutoReviewAt: longAgo })).toBe(true);
  });

  it('cooldown is configurable', () => {
    const fiveAgo = base.now - 5 * 60_000;
    expect(shouldAutoReview({ ...base, learning: { cooldownMinutes: 4 }, lastAutoReviewAt: fiveAgo })).toBe(true);
    expect(shouldAutoReview({ ...base, learning: { cooldownMinutes: 6 }, lastAutoReviewAt: fiveAgo })).toBe(false);
  });
});

describe('resolveRoomLearning', () => {
  const routing = { channelType: 'webchat', platformId: 'excavating' };
  it('room override wins over the agent level', () => {
    const learning = { autoTrigger: true, rooms: { 'webchat:excavating': { autoTrigger: false } } };
    expect(resolveRoomLearning(learning, routing)?.autoTrigger).toBe(false);
  });
  it('rooms without an entry inherit agent settings; cooldown passes through', () => {
    const learning = { autoTrigger: false, cooldownMinutes: 5, rooms: { 'webchat:other-room': { autoTrigger: true } } };
    const r = resolveRoomLearning(learning, routing);
    expect(r?.autoTrigger).toBe(false);
    expect(r?.cooldownMinutes).toBe(5);
  });
  it('tolerates missing learning / routing fields', () => {
    expect(resolveRoomLearning(undefined, routing)).toBeUndefined();
    expect(resolveRoomLearning({ autoKeep: true }, { channelType: null, platformId: null })?.autoKeep).toBe(true);
  });
});
