/**
 * Digest-based learning review + adaptive cadence (docs/webchat/learning-loop.md §2).
 *
 * The Hermes-inspired cost cut: the review reads a BOUNDED digest of recent
 * exchanges and runs as a fresh query, instead of forking the live session and
 * replaying the whole transcript at main-model price. These tests pin:
 *   - the digest builder's bounds (entry count, per-field truncation, total cap);
 *   - the dry-streak cooldown backoff math and its state transitions;
 *   - reviewModel resolution (default = no override; config wins);
 *   - the query shape per mode (digest fresh / replay fork / no-log fallback);
 *   - the /learn user hint surviving into the digest-mode prompt.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from './db/connection.js';
import { writeMessageOut } from './db/messages-out.js';
import type { MessageInRow } from './db/messages-in.js';
import { MockProvider, type MockResponse } from './providers/mock.js';
import type { QueryInput } from './providers/types.js';
import type { PollLoopConfig } from './poll-loop.js';
import {
  DIGEST_ENTRY_MAX_CHARS,
  DIGEST_MAX_CHARS,
  DIGEST_MAX_EXCHANGES,
  DRY_STREAK_BACKOFF_CAP,
  AUTO_REVIEW_MIN_TOOLS,
  backoffMultiplier,
  buildDigestReviewPrompt,
  buildLearnReviewPrompt,
  buildReviewDigest,
  createAutoReviewHook,
  createAutoReviewState,
  createExchangeLog,
  recordExchange,
  resolveReviewModel,
  runLearningReview,
  shouldAutoReview,
  truncateMiddle,
  wrapExchangeHook,
  type LearningConfig,
} from './learning-loop.js';

// ── pure digest builder ─────────────────────────────────────────────────────

describe('truncateMiddle', () => {
  it('returns short text unchanged', () => {
    expect(truncateMiddle('hello', 100)).toBe('hello');
  });

  it('keeps head and tail, bounded by max', () => {
    const text = 'A'.repeat(3000) + 'MIDDLE' + 'Z'.repeat(3000);
    const out = truncateMiddle(text, 1000);
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out.startsWith('AAAA')).toBe(true);
    expect(out.endsWith('ZZZZ')).toBe(true);
    expect(out).toContain('chars truncated');
    expect(out).not.toContain('MIDDLE');
  });
});

describe('buildReviewDigest', () => {
  it('returns null for an empty log (caller falls back to replay)', () => {
    expect(buildReviewDigest(createExchangeLog())).toBeNull();
  });

  it('renders exchanges oldest-first with user/agent labels', () => {
    const log = createExchangeLog();
    recordExchange(log, { prompt: 'first ask', result: 'first answer' });
    recordExchange(log, { prompt: 'second ask', result: 'second answer' });
    const digest = buildReviewDigest(log)!;
    expect(digest.indexOf('first ask')).toBeLessThan(digest.indexOf('second ask'));
    expect(digest).toContain('[user → agent]');
    expect(digest).toContain('[agent]');
  });

  it('a null result renders as an explicit placeholder', () => {
    const log = createExchangeLog();
    recordExchange(log, { prompt: 'silent turn', result: null });
    expect(buildReviewDigest(log)).toContain('(no reply text)');
  });

  it('the log retains only the newest DIGEST_MAX_EXCHANGES entries', () => {
    const log = createExchangeLog();
    for (let i = 0; i < DIGEST_MAX_EXCHANGES + 8; i++) {
      recordExchange(log, { prompt: `ask-${i}`, result: `ans-${i}` });
    }
    expect(log.entries.length).toBe(DIGEST_MAX_EXCHANGES);
    const digest = buildReviewDigest(log)!;
    expect(digest).not.toContain('ask-0'); // oldest evicted
    expect(digest).toContain(`ask-${DIGEST_MAX_EXCHANGES + 7}`); // newest kept
  });

  it('per-field truncation bounds each entry (head/tail kept)', () => {
    const log = createExchangeLog();
    const long = 'H'.repeat(DIGEST_ENTRY_MAX_CHARS) + 'CUT-THIS' + 'T'.repeat(DIGEST_ENTRY_MAX_CHARS);
    recordExchange(log, { prompt: long, result: 'ok' });
    const digest = buildReviewDigest(log)!;
    expect(digest).not.toContain('CUT-THIS');
    expect(digest).toContain('chars truncated');
    expect(digest).toContain('HHHH');
    expect(digest).toContain('TTTT');
  });

  it('total size never exceeds DIGEST_MAX_CHARS; newest exchanges win the budget', () => {
    const log = createExchangeLog();
    for (let i = 0; i < DIGEST_MAX_EXCHANGES; i++) {
      // Each entry lands near the per-field cap so the total budget runs out.
      recordExchange(log, {
        prompt: `ask-${i} ` + 'p'.repeat(DIGEST_ENTRY_MAX_CHARS),
        result: `ans-${i} ` + 'r'.repeat(DIGEST_ENTRY_MAX_CHARS),
      });
    }
    const digest = buildReviewDigest(log)!;
    expect(digest.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    expect(digest).toContain(`ask-${DIGEST_MAX_EXCHANGES - 1}`); // newest present
    expect(digest).not.toContain('ask-0 '); // oldest dropped for budget
  });
});

describe('wrapExchangeHook', () => {
  it('records into the log and forwards to the inner hook', () => {
    const log = createExchangeLog();
    const seen: string[] = [];
    const hook = wrapExchangeHook(log, (ex) => seen.push(ex.prompt));
    hook({ prompt: 'p1', result: 'r1', status: 'completed' });
    expect(log.entries).toEqual([{ prompt: 'p1', result: 'r1' }]);
    expect(seen).toEqual(['p1']);
  });

  it('records even when there is no inner hook, and BEFORE a throwing one', () => {
    const log = createExchangeLog();
    wrapExchangeHook(log, undefined)({ prompt: 'p1', result: null, status: 'completed' });
    expect(log.entries.length).toBe(1);
    const throwing = wrapExchangeHook(log, () => {
      throw new Error('inner exploded');
    });
    expect(() => throwing({ prompt: 'p2', result: 'r2', status: 'completed' })).toThrow('inner exploded');
    expect(log.entries.length).toBe(2); // the record survived the throw
  });
});

describe('buildDigestReviewPrompt — /learn hint preserved', () => {
  it('carries the user hint from buildLearnReviewPrompt verbatim, plus the digest block', () => {
    const hinted = buildLearnReviewPrompt('/learn keep the rsync part even though it is well-known');
    const prompt = buildDigestReviewPrompt(hinted, 'DIGEST-BODY');
    expect(prompt).toContain('keep the rsync part even though it is well-known');
    expect(prompt).toContain('DO NOT draft a skill for');
    expect(prompt).toContain('<session-digest>\nDIGEST-BODY\n</session-digest>');
  });
});

// ── adaptive cadence (dry-streak backoff) ───────────────────────────────────

describe('backoffMultiplier', () => {
  it('doubles per dry review and caps at 8x', () => {
    expect(backoffMultiplier(0)).toBe(1);
    expect(backoffMultiplier(1)).toBe(2);
    expect(backoffMultiplier(2)).toBe(4);
    expect(backoffMultiplier(3)).toBe(DRY_STREAK_BACKOFF_CAP);
    expect(backoffMultiplier(4)).toBe(DRY_STREAK_BACKOFF_CAP);
    expect(backoffMultiplier(1000)).toBe(DRY_STREAK_BACKOFF_CAP);
  });

  it('tolerates garbage', () => {
    expect(backoffMultiplier(-1)).toBe(1);
    expect(backoffMultiplier(Number.NaN)).toBe(1);
  });
});

describe('shouldAutoReview with a dry streak', () => {
  const base = {
    learning: { cooldownMinutes: 30 } as LearningConfig,
    supportsRestrictedReview: true,
    toolCount: AUTO_REVIEW_MIN_TOOLS,
    hadLearnCommand: false,
    now: 1_800_000_000_000,
  };

  it('streak 1 doubles the effective cooldown', () => {
    const at31 = base.now - 31 * 60_000;
    expect(shouldAutoReview({ ...base, lastAutoReviewAt: at31, dryStreak: 0 })).toBe(true);
    expect(shouldAutoReview({ ...base, lastAutoReviewAt: at31, dryStreak: 1 })).toBe(false);
    const at61 = base.now - 61 * 60_000;
    expect(shouldAutoReview({ ...base, lastAutoReviewAt: at61, dryStreak: 1 })).toBe(true);
  });

  it('deep streaks cap at 8x the base cooldown', () => {
    const at239 = base.now - 239 * 60_000;
    const at241 = base.now - 241 * 60_000;
    expect(shouldAutoReview({ ...base, lastAutoReviewAt: at239, dryStreak: 10 })).toBe(false);
    expect(shouldAutoReview({ ...base, lastAutoReviewAt: at241, dryStreak: 10 })).toBe(true);
  });
});

// ── reviewModel resolution ──────────────────────────────────────────────────

describe('resolveReviewModel', () => {
  it('absent config = no override (current behavior default)', () => {
    expect(resolveReviewModel(undefined)).toBeUndefined();
    expect(resolveReviewModel({})).toBeUndefined();
    expect(resolveReviewModel({ reviewModel: '' })).toBeUndefined();
    expect(resolveReviewModel({ reviewModel: '   ' })).toBeUndefined();
  });

  it('a configured model is returned trimmed', () => {
    expect(resolveReviewModel({ reviewModel: ' haiku ' })).toBe('haiku');
  });
});

// ── runLearningReview: query shape + outcome (needs session DBs) ────────────

class RestrictedMock extends MockProvider {
  readonly supportsRestrictedReview = true;
}

const routing = { platformId: 'room-1', channelType: 'webchat', threadId: 'main', inReplyTo: null, taskRun: false };

function makeConfig(
  factory: (prompt: string, input: QueryInput) => MockResponse,
  learning?: LearningConfig,
): PollLoopConfig {
  return { provider: new RestrictedMock({}, factory), providerName: 'mock', cwd: '/tmp', learning };
}

describe('runLearningReview (digest / replay / outcome)', () => {
  beforeEach(() => {
    initTestSessionDb();
  });
  afterEach(() => {
    closeSessionDb();
  });

  it('digest mode: fresh query (no continuation), digest in prompt, reviewModel override wired', async () => {
    const inputs: QueryInput[] = [];
    const config = makeConfig(
      (_p, input) => {
        inputs.push(input);
        return { result: 'Nothing worth keeping.' };
      },
      { reviewModel: 'haiku' },
    );
    const outcome = await runLearningReview(config, routing, [] as MessageInRow[], 'cont-live', undefined, {
      digest: 'exchange one taught X',
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0].learningReview).toBe(true);
    expect(inputs[0].continuation).toBeUndefined(); // fresh — nothing replayed
    expect(inputs[0].prompt).toContain('<session-digest>');
    expect(inputs[0].prompt).toContain('exchange one taught X');
    expect(inputs[0].model).toBe('haiku');
    expect(outcome).toBe('declined');
  });

  it('default model: no reviewModel key = no per-query override', async () => {
    const inputs: QueryInput[] = [];
    const config = makeConfig((_p, input) => {
      inputs.push(input);
      return { result: 'ok' };
    });
    await runLearningReview(config, routing, [], undefined, undefined, { digest: 'd' });
    expect(inputs[0].model).toBeUndefined();
  });

  it('replayReview: true forks the live continuation, no digest block', async () => {
    const inputs: QueryInput[] = [];
    const config = makeConfig(
      (_p, input) => {
        inputs.push(input);
        return { result: 'ok' };
      },
      { replayReview: true },
    );
    await runLearningReview(config, routing, [], 'cont-live', undefined, { digest: 'should be ignored' });
    expect(inputs[0].continuation).toBe('cont-live');
    expect(inputs[0].prompt).not.toContain('<session-digest>');
  });

  it('no digest recorded yet falls back to the replay path (fresh-container /learn)', async () => {
    const inputs: QueryInput[] = [];
    const config = makeConfig((_p, input) => {
      inputs.push(input);
      return { result: 'ok' };
    });
    await runLearningReview(config, routing, [], 'cont-live', undefined, { digest: null });
    expect(inputs[0].continuation).toBe('cont-live');
    expect(inputs[0].prompt).not.toContain('<session-digest>');
  });

  it("outcome 'proposed' when draft_skill wrote a propose_skill row during the review", async () => {
    const config = makeConfig(() => {
      // Simulate the MCP-subprocess draft_skill write landing in outbound.db.
      writeMessageOut({
        id: `msg-test-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'system',
        content: JSON.stringify({ action: 'propose_skill', skill_name: 'x', body: 'b', kind: 'create' }),
      });
      return { result: 'Drafted "x".' };
    });
    const outcome = await runLearningReview(config, routing, [], undefined, undefined, { digest: 'd' });
    expect(outcome).toBe('proposed');
  });

  it("outcome 'error' on a non-retryable review error", async () => {
    const config = makeConfig(() => ({ error: { message: 'boom', retryable: false } }));
    const outcome = await runLearningReview(config, routing, [], undefined, undefined, { digest: 'd' });
    expect(outcome).toBe('error');
  });
});

describe('auto-review hook — dry-streak state transitions', () => {
  beforeEach(() => {
    initTestSessionDb();
  });
  afterEach(() => {
    closeSessionDb();
  });

  async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('declines grow the streak; a proposal resets it; the digest feeds the review', async () => {
    const state = createAutoReviewState();
    const exchangeLog = createExchangeLog();
    recordExchange(exchangeLog, { prompt: 'busy ask', result: 'busy answer' });

    let respond: () => MockResponse = () => ({ result: 'nothing' });
    const inputs: QueryInput[] = [];
    const config = makeConfig(
      (_p, input) => {
        inputs.push(input);
        return respond();
      },
      { cooldownMinutes: 0 }, // let consecutive runs through; cadence math is unit-tested above
    );
    const hook = createAutoReviewHook({
      state,
      config,
      routing,
      messages: [],
      hadLearnCommand: false,
      getContinuation: () => 'cont-live',
      exchangeLog,
    });

    hook(AUTO_REVIEW_MIN_TOOLS); // dry
    await waitFor(() => !state.inFlight && state.dryStreak === 1);
    hook(AUTO_REVIEW_MIN_TOOLS); // dry again
    await waitFor(() => !state.inFlight && state.dryStreak === 2);

    // The auto review ran on the digest, not the fork.
    expect(inputs[0].continuation).toBeUndefined();
    expect(inputs[0].prompt).toContain('busy ask');

    respond = () => {
      writeMessageOut({
        id: `msg-test-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'system',
        content: JSON.stringify({ action: 'propose_skill', skill_name: 'y', body: 'b', kind: 'create' }),
      });
      return { result: 'Drafted "y".' };
    };
    hook(AUTO_REVIEW_MIN_TOOLS); // proposal
    await waitFor(() => !state.inFlight && state.dryStreak === 0);
  });

  it('an errored review leaves the streak untouched', async () => {
    const state = createAutoReviewState();
    state.dryStreak = 2;
    const config = makeConfig(() => ({ error: { message: 'boom', retryable: false } }), { cooldownMinutes: 0 });
    const hook = createAutoReviewHook({
      state,
      config,
      routing,
      messages: [],
      hadLearnCommand: false,
      getContinuation: () => undefined,
      exchangeLog: createExchangeLog(),
    });
    hook(AUTO_REVIEW_MIN_TOOLS);
    await new Promise((r) => setTimeout(r, 150));
    expect(state.inFlight).toBe(false);
    expect(state.dryStreak).toBe(2);
  });
});
