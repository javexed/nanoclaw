import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { dispatchResultText } from './poll-loop.js';

// A correct answer with no envelope is still a correct answer.
//
// The wrap-nudge asks the model to re-send its reply wrapped. A capable model
// does; a smaller one answers the nudge instead. Observed on a local 8B, twice
// in a row, with the right text already produced:
//
//   [assistant] 'hello'                       ← the answer, unwrapped
//   [user]      '<system>Your response was not delivered …'
//   [assistant] '<message to="…">Received. All future responses will be
//                properly wrapped …</message>'
//
// With exactly one destination there is no question who the reply was for, so
// it is delivered rather than re-requested. With several it stays ambiguous and
// the nudge is still right.

const CHAT_ROUTING = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm1',
  taskRun: false,
};

function seedDest(name: string, platformId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', 'discord', ?, NULL)`,
    )
    .run(name, name, platformId);
}

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

describe('unwrapped reply, single destination', () => {
  it('delivers the answer instead of nudging', async () => {
    seedDest('the-room', 'chan-1');
    const res = await dispatchResultText('hello', CHAT_ROUTING);
    expect(res.hasUnwrapped).toBe(false); // no nudge — the turn counts as delivered
    expect(res.sent).toBe(1);
    const out = getUndeliveredMessages();
    expect(out.length).toBe(1);
    expect(JSON.parse(out[0].content).text).toBe('hello');
  });

  it('still nudges when there are two destinations — who it was for is a real question', async () => {
    seedDest('the-room', 'chan-1');
    seedDest('ops', 'chan-2');
    const res = await dispatchResultText('hello', CHAT_ROUTING);
    expect(res.hasUnwrapped).toBe(true);
    expect(res.sent).toBe(0);
    expect(getUndeliveredMessages().length).toBe(0);
  });

  it('leaves a properly wrapped reply alone', async () => {
    seedDest('the-room', 'chan-1');
    const res = await dispatchResultText('<message to="the-room">hi</message>', CHAT_ROUTING);
    expect(res.hasUnwrapped).toBe(false);
    expect(res.sent).toBe(1);
    expect(JSON.parse(getUndeliveredMessages()[0].content).text).toBe('hi');
  });

  it('does not invent a message out of pure <internal> scratchpad', async () => {
    // Stripped to nothing, so there is no answer to deliver and nothing to nudge.
    seedDest('the-room', 'chan-1');
    const res = await dispatchResultText('<internal>just thinking</internal>', CHAT_ROUTING);
    expect(res.sent).toBe(0);
    expect(getUndeliveredMessages().length).toBe(0);
  });

  it('never sends from the result door under suppressDelivery', async () => {
    // Mid-turn providers own the single content door; wrapping here would
    // either double-send or bypass it. The nudge remains the correct outcome.
    seedDest('the-room', 'chan-1');
    const res = await dispatchResultText('hello', CHAT_ROUTING, {
      suppressDelivery: true,
      turnDelivered: false,
    });
    expect(res.hasUnwrapped).toBe(true);
    expect(getUndeliveredMessages().length).toBe(0);
  });
});
