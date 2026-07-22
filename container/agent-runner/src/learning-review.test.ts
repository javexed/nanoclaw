/**
 * The isolated learning review (docs/webchat/design/learning-loop.md §2).
 *
 * /learn must NOT become an ordinary turn when the provider can do better: it
 * runs as a second query flagged `learningReview` — which the claude provider
 * translates into "draft_skill only". These tests pin the runner-side
 * contract: the flag is set, the prompt is the authoring instruction, the
 * trigger message is consumed, and a reply still reaches the room. Providers
 * that can't restrict get the fallback: the same review as a normal turn with
 * the prompt swapped in.
 *
 * Context: when the container has seen exchanges, the review runs FRESH over
 * a bounded digest of them (no continuation — nothing replayed); with no
 * exchanges yet (e.g. /learn as the container's first message), it falls back
 * to the old replay path. See learning-digest.test.ts for the digest bounds.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './db/connection.js';
import { getPendingMessages } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { runPollLoop } from './poll-loop.js';
import { MockProvider } from './providers/mock.js';
import type { QueryInput } from './providers/types.js';

beforeEach(() => {
  initTestSessionDb();
  // Seed the room as a destination so the review's <message to="room-1"> reply
  // resolves — the same seeding the poll-loop integration tests use.
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('room-1', 'Room One', 'channel', 'webchat', 'room-1', NULL)`,
    )
    .run();
});
afterEach(() => {
  closeSessionDb();
});

function insertLearn(id = 'learn-1') {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', 'room-1', 'webchat', 'main', ?)`,
    )
    .run(id, JSON.stringify({ sender: 'Op', text: '/learn' }));
}

async function waitFor(cond: () => boolean, ms: number): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

class RestrictedMock extends MockProvider {
  readonly supportsRestrictedReview = true;
}

describe('isolated learning review', () => {
  it('runs /learn as a learningReview query with the authoring prompt, not as a turn', async () => {
    insertLearn();
    const inputs: QueryInput[] = [];
    const provider = new RestrictedMock({}, (_prompt, input) => {
      inputs.push(input);
      return { result: '<message to="room-1">Nothing worth keeping.</message>' };
    });

    const controller = new AbortController();
    const loop = runPollLoop({ provider, providerName: 'mock', cwd: '/tmp', signal: controller.signal });
    await waitFor(() => getUndeliveredMessages().length > 0, 3000);
    controller.abort();
    await loop.catch(() => {});

    // Exactly one query, and it is the REVIEW — not a normal turn carrying the
    // /learn text.
    expect(inputs).toHaveLength(1);
    expect(inputs[0].learningReview).toBe(true);
    expect(inputs[0].prompt).toContain('DO NOT draft a skill for');
    expect(inputs[0].prompt).not.toContain('<message'); // authoring prompt, not formatted chat

    // The one-sentence outcome still reaches the room.
    const out = getUndeliveredMessages();
    expect(JSON.parse(out[0].content).text).toBe('Nothing worth keeping.');

    // The trigger message is consumed.
    expect(getPendingMessages()).toHaveLength(0);
  });

  it('falls back to an in-turn review when the provider cannot restrict', async () => {
    insertLearn();
    const inputs: QueryInput[] = [];
    // Plain MockProvider: no supportsRestrictedReview.
    const provider = new MockProvider({}, (_prompt, input) => {
      inputs.push(input);
      return { result: '<message to="room-1">Reviewed inline.</message>' };
    });

    const controller = new AbortController();
    const loop = runPollLoop({ provider, providerName: 'mock', cwd: '/tmp', signal: controller.signal });
    await waitFor(() => getUndeliveredMessages().length > 0, 3000);
    controller.abort();
    await loop.catch(() => {});

    expect(inputs).toHaveLength(1);
    // An ordinary turn: no review flag, prompt is the formatted chat carrying
    // the authoring instruction where the /learn text was.
    expect(inputs[0].learningReview).toBeUndefined();
    expect(inputs[0].prompt).toContain('<message');
    expect(inputs[0].prompt).toContain('DO NOT draft a skill for');
    expect(getPendingMessages()).toHaveLength(0);
  });

  it('reviews over the exchange digest — fresh query, prior turn in the prompt, nothing replayed', async () => {
    // A real turn first, so the exchange log has something to digest.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', 'room-1', 'webchat', 'main', ?)`,
      )
      .run(JSON.stringify({ sender: 'Op', text: 'please fix the rsync flags' }));

    const inputs: QueryInput[] = [];
    const provider = new RestrictedMock({}, (_prompt, input) => {
      inputs.push(input);
      return input.learningReview
        ? { result: '<message to="room-1">Nothing worth keeping.</message>' }
        : { result: '<message to="room-1">rsync fixed with -aHAX</message>' };
    });

    const controller = new AbortController();
    const loop = runPollLoop({ provider, providerName: 'mock', cwd: '/tmp', signal: controller.signal });
    await waitFor(() => getUndeliveredMessages().length > 0, 3000);
    insertLearn('learn-2');
    await waitFor(() => inputs.some((i) => i.learningReview === true), 3000);
    controller.abort();
    await loop.catch(() => {});

    const review = inputs.find((i) => i.learningReview === true)!;
    // Fresh query: the stored continuation from the first turn is NOT replayed…
    expect(review.continuation).toBeUndefined();
    // …because the digest carries the context instead: both sides of the turn.
    expect(review.prompt).toContain('<session-digest>');
    expect(review.prompt).toContain('please fix the rsync flags');
    expect(review.prompt).toContain('rsync fixed with -aHAX');
    expect(review.prompt).toContain('DO NOT draft a skill for');
  });
});
