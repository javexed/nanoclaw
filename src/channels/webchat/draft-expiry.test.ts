/**
 * Draft expiry: pending drafts self-discard only when they're BOTH old (>24h)
 * AND their in-room card has scrolled out of the chat. Age alone never kills a
 * card a human might be looking at; visibility alone never kills a fresh draft.
 */
import { describe, expect, it } from 'vitest';
import { DRAFT_EXPIRY_MS, DRAFT_SCROLLED_AWAY_MESSAGES, draftHasExpired } from './index.js';

const H = 60 * 60 * 1000;

describe('draftHasExpired', () => {
  it('never expires anything younger than 24h, however buried', () => {
    expect(draftHasExpired(23 * H, { newerMessages: 500 })).toBe(false);
  });

  it('never expires an old draft whose card is still in view', () => {
    expect(draftHasExpired(48 * H, { newerMessages: DRAFT_SCROLLED_AWAY_MESSAGES - 1 })).toBe(false);
    expect(draftHasExpired(400 * H, { newerMessages: 0 })).toBe(false);
  });

  it('expires an old draft whose card has scrolled away', () => {
    expect(draftHasExpired(DRAFT_EXPIRY_MS + 1, { newerMessages: DRAFT_SCROLLED_AWAY_MESSAGES })).toBe(true);
  });

  it('a draft with no card at all expires on age alone', () => {
    expect(draftHasExpired(DRAFT_EXPIRY_MS + 1, null)).toBe(true);
    expect(draftHasExpired(1 * H, null)).toBe(false);
  });
});
