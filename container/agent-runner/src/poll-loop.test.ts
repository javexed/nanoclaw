import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import {
  initTestSessionDb,
  closeSessionDb,
  getInboundDb,
  getOutboundDb,
  appendStatusEvent,
  clearStatusEvents,
} from './db/connection.js';
import { getPendingMessages, markCompleted } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { findByRouting } from './destinations.js';
import { formatMessages, extractRouting } from './formatter.js';
import { isCorruptionError, processQuery } from './poll-loop.js';
import { MockProvider } from './providers/mock.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(
  id: string,
  kind: string,
  content: object,
  opts?: { processAfter?: string; trigger?: 0 | 1; onWake?: 0 | 1 },
) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, on_wake, content)
     VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, kind, opts?.processAfter ?? null, opts?.trigger ?? 1, opts?.onWake ?? 0, JSON.stringify(content));
}

describe('formatter', () => {
  it('should format a single chat message', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello world' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('Hello world');
  });

  it('should format multiple chat messages as distinct <message> blocks', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'chat', { sender: 'Jane', text: 'Hi there' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    // The <messages> envelope was dropped in fe2e881b (#2556) so the SDK calls
    // the API; each message is now its own self-contained <message> block.
    expect(prompt).not.toContain('<messages>');
    expect(prompt.match(/<message /g) ?? []).toHaveLength(2);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('sender="Jane"');
  });

  it('should format task messages', () => {
    insertMessage('m1', 'task', { prompt: 'Review open PRs' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<task');
    expect(prompt).toContain('Review open PRs');
  });

  it('should format webhook messages', () => {
    insertMessage('m1', 'webhook', { source: 'github', event: 'push', payload: { ref: 'main' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('source="github"');
    expect(prompt).toContain('event="push"');
  });

  it('should format system messages', () => {
    insertMessage('m1', 'system', { action: 'register_group', status: 'success', result: { id: 'ag-1' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('action="register_group"');
  });

  it('should handle mixed kinds', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'system', { action: 'test', status: 'ok', result: null });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('<system_response');
  });

  it('should escape XML in content', () => {
    insertMessage('m1', 'chat', { sender: 'A<B', text: 'x > y && z' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('A&lt;B');
    expect(prompt).toContain('x &gt; y &amp;&amp; z');
  });
});

describe('accumulate gate (trigger column)', () => {
  it('getPendingMessages returns both trigger=0 and trigger=1 rows', () => {
    // trigger=0 rides along as context, trigger=1 is the wake-eligible row.
    // The poll loop's gate depends on this data contract.
    insertMessage('m1', 'chat', { sender: 'A', text: 'chit chat' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'actual mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages).toHaveLength(2);
    const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
    expect(byId.m1.trigger).toBe(0);
    expect(byId.m2.trigger).toBe(1);
  });

  it('trigger=0-only batch: gate predicate `some(trigger===1)` is false', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'noise' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'more noise' }, { trigger: 0 });
    const messages = getPendingMessages();
    // This is the exact predicate the poll loop uses to skip accumulate-only
    // batches — gate should be false, so the loop sleeps without waking the agent.
    expect(messages.some((m) => m.trigger === 1)).toBe(false);
  });

  it('mixed batch: gate is true → loop proceeds, accumulated rows ride along', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'earlier chatter' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'the real mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages.some((m) => m.trigger === 1)).toBe(true);
    // Both messages are present for the formatter → agent sees the prior context.
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('trigger column defaults to 1 for legacy inserts without explicit value', () => {
    // The schema default is 1 (see src/db/schema.ts INBOUND_SCHEMA) — existing
    // rows / tests without the column set are effectively wake-eligible.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    const [msg] = getPendingMessages();
    expect(msg.trigger).toBe(1);
  });
});

describe('on_wake filtering', () => {
  it('first poll returns on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('subsequent polls skip on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(0);
  });

  it('normal messages returned regardless of isFirstPoll', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'hello' });
    expect(getPendingMessages(true)).toHaveLength(1);

    // Reset: mark completed so we can re-test with a fresh message
    markCompleted(['m1']);
    insertMessage('m2', 'chat', { sender: 'A', text: 'hello again' });
    expect(getPendingMessages(false)).toHaveLength(1);
  });

  it('mixed batch: first poll returns both normal and on_wake messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('mixed batch: subsequent poll returns only normal messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('on_wake defaults to 0 for inserts without explicit value', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    // Should be returned even on non-first poll (on_wake=0)
    expect(getPendingMessages(false)).toHaveLength(1);
  });
});

describe('routing', () => {
  it('should extract routing from messages', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-123', 'discord', 'thread-456', '{"text":"hi"}')`,
      )
      .run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('chan-123');
    expect(routing.channelType).toBe('discord');
    expect(routing.threadId).toBe('thread-456');
    expect(routing.inReplyTo).toBe('m1');
  });
});

describe('origin metadata (from= attribute)', () => {
  function seedDestination(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }

  function insertWithRouting(id: string, kind: string, content: object, channelType: string | null, platformId: string | null): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?)`,
      )
      .run(id, kind, platformId, channelType, JSON.stringify(content));
  }

  it('chat message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="discord-main"');
  });

  it('chat message falls back to raw routing when no destination matches', () => {
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'telegram', 'chat-999');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="unknown:telegram:chat-999"');
  });

  it('chat message omits from= when routing is null', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).not.toContain('from=');
  });

  it('task message includes from= when destination matches', () => {
    seedDestination('slack-ops', 'slack', 'C-OPS');
    insertWithRouting('t1', 'task', { prompt: 'check status' }, 'slack', 'C-OPS');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).toContain('from="slack-ops"');
  });

  it('task message omits from= when routing is null', () => {
    insertMessage('t1', 'task', { prompt: 'check status' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).not.toContain('from=');
  });

  it('webhook message includes from= when destination matches', () => {
    seedDestination('github-ch', 'github', 'repo-1');
    insertWithRouting('w1', 'webhook', { source: 'github', event: 'push', payload: {} }, 'github', 'repo-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('from="github-ch"');
  });

  it('system message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('s1', 'system', { action: 'test', status: 'ok', result: null }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('from="discord-main"');
  });
});

describe('mock provider', () => {
  it('should produce init + result events', async () => {
    const provider = new MockProvider({}, (prompt) => `Echo: ${prompt}`);
    const query = provider.query({
      prompt: 'Hello',
      cwd: '/tmp',
    });

    const events: Array<{ type: string }> = [];
    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      events.push(event);
    }

    const typed = events.filter((e) => e.type !== 'activity');
    expect(typed.length).toBeGreaterThanOrEqual(2);
    expect(typed[0].type).toBe('init');
    expect(typed[1].type).toBe('result');
    expect((typed[1] as { text: string }).text).toBe('Echo: Hello');
  });

  it('should handle push() during active query', async () => {
    const provider = new MockProvider({}, (prompt) => `Re: ${prompt}`);
    const query = provider.query({
      prompt: 'First',
      cwd: '/tmp',
    });

    const events: Array<{ type: string; text?: string }> = [];

    setTimeout(() => query.push('Second'), 30);
    setTimeout(() => query.end(), 60);

    for await (const event of query.events) {
      events.push(event);
    }

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(2);
    expect(results[0].text).toBe('Re: First');
    expect(results[1].text).toBe('Re: Second');
  });
});

describe('end-to-end with mock provider', () => {
  it('should read messages_in, process with mock provider, write messages_out', async () => {
    // Insert a chat message into inbound DB
    insertMessage('m1', 'chat', { sender: 'User', text: 'What is 2+2?' });

    // Read and process
    const messages = getPendingMessages();
    expect(messages).toHaveLength(1);

    const routing = extractRouting(messages);
    const prompt = formatMessages(messages);

    // Create mock provider and run query
    const provider = new MockProvider({}, () => 'The answer is 4');
    const query = provider.query({
      prompt,
      cwd: '/tmp',
    });

    // Process events — simulate what poll-loop does
    const { markProcessing } = await import('./db/messages-in.js');
    const { writeMessageOut } = await import('./db/messages-out.js');

    markProcessing(['m1']);

    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      if (event.type === 'result' && event.text) {
        writeMessageOut({
          id: `out-${Date.now()}`,
          in_reply_to: routing.inReplyTo,
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: event.text }),
        });
      }
    }

    markCompleted(['m1']);

    // Verify: message was processed (not pending, acked in processing_ack)
    const processed = getPendingMessages();
    expect(processed).toHaveLength(0);

    // Verify: response was written to outbound DB
    const outMessages = getUndeliveredMessages();
    expect(outMessages).toHaveLength(1);
    expect(JSON.parse(outMessages[0].content).text).toBe('The answer is 4');
    expect(outMessages[0].in_reply_to).toBe('m1');
  });
});

/**
 * Build a one-shot stub query that yields init + a single result event, then
 * ends. `pushes` records any follow-ups the loop tried to inject (e.g. the
 * re-wrap nudge), so a test can assert the loop did NOT re-hammer.
 */
function makeResultQuery(result: ProviderEvent): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 'sess-1' };
    yield result;
  }
  return {
    pushes,
    query: {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    },
  };
}

const ERR_ROUTING = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm1',
};

describe('error result with no <message> envelope', () => {
  it('delivers a budget/billing error to the triggering channel and does not nudge', async () => {
    const budgetText = 'Spending limit reached. Add your own key at https://example.com/keys';
    const { query, pushes } = makeResultQuery({ type: 'result', text: budgetText, isError: true });

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe(budgetText);
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    // No re-wrap nudge — an error result must not re-hammer the gateway.
    expect(pushes).toHaveLength(0);
  });

  it('still nudges (and does not deliver) a normal unwrapped result', async () => {
    const { query, pushes } = makeResultQuery({ type: 'result', text: 'bare text, no envelope' });

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(getUndeliveredMessages()).toHaveLength(0);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('was not delivered');
  });
});

describe('isCorruptionError', () => {
  it('matches the Docker Desktop macOS torn-read symptom', () => {
    expect(isCorruptionError('database disk image is malformed')).toBe(true);
  });

  it('matches wrapped SQLite corruption codes', () => {
    expect(isCorruptionError('SqliteError: SQLITE_CORRUPT_VTAB: ...')).toBe(true);
    expect(isCorruptionError('file is not a database')).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isCorruptionError('database is locked')).toBe(false);
    expect(isCorruptionError('no such table: messages_in')).toBe(false);
    expect(isCorruptionError('')).toBe(false);
  });
});

describe('webchat thinking feed cycling (follow-ups in an active query)', () => {
  function statusKinds(): string[] {
    return (getOutboundDb().prepare('SELECT kind FROM status_events ORDER BY seq ASC').all() as { kind: string }[]).map(
      (r) => r.kind,
    );
  }

  it('emits a status "done" when a result lands so the bubble settles', async () => {
    // The outer poll loop seeds 'start' before calling processQuery.
    clearStatusEvents();
    appendStatusEvent('start', null);

    const { query } = makeResultQuery({ type: 'result', text: 'bare text, no envelope' });
    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    // Without the fix, processQuery never appends 'done' (the outer-loop 'done'
    // is outside processQuery), so the bubble would never settle on a result.
    expect(statusKinds()).toContain('done');
  });
});

describe('origin guard — reply pinned to the originating room', () => {
  function seedChannel(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }

  // Message arrived from room-a; the guard's job is to keep replies there.
  const ORIGIN_ROUTING = { platformId: 'room-a', channelType: 'webchat', threadId: null, inReplyTo: 'm1' };

  it('redirects a lone reply that resolves to a different room back to origin', async () => {
    seedChannel('room-a', 'webchat', 'room-a');
    seedChannel('room-b', 'webchat', 'room-b');
    const originDests = [findByRouting('webchat', 'room-a')!];
    const { query } = makeResultQuery({ type: 'result', text: '<message to="room-b">answer for the user</message>' });

    await processQuery(query, ORIGIN_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, originDests);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('room-a'); // pinned back to origin, not room-b
    expect(JSON.parse(out[0].content).text).toBe('answer for the user');
  });

  it('leaves a reply already addressed to the origin room untouched', async () => {
    seedChannel('room-a', 'webchat', 'room-a');
    const originDests = [findByRouting('webchat', 'room-a')!];
    const { query } = makeResultQuery({ type: 'result', text: '<message to="room-a">hello</message>' });

    await processQuery(query, ORIGIN_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, originDests);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('room-a');
  });

  it('honors a deliberate cross-room send (multiple blocks are not guarded)', async () => {
    seedChannel('room-a', 'webchat', 'room-a');
    seedChannel('room-b', 'webchat', 'room-b');
    const originDests = [findByRouting('webchat', 'room-a')!];
    const { query } = makeResultQuery({
      type: 'result',
      text: '<message to="room-a">ack</message><message to="room-b">heads up</message>',
    });

    await processQuery(query, ORIGIN_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, originDests);

    const targets = getUndeliveredMessages()
      .map((o) => o.platform_id)
      .sort();
    expect(targets).toEqual(['room-a', 'room-b']);
  });

  it('treats every room in the batch as a valid origin (agent-shared)', async () => {
    seedChannel('room-a', 'webchat', 'room-a');
    seedChannel('room-b', 'webchat', 'room-b');
    // Batch spanned both rooms — a lone reply to either is legitimate, not a misfire.
    const originDests = [findByRouting('webchat', 'room-a')!, findByRouting('webchat', 'room-b')!];
    const { query } = makeResultQuery({ type: 'result', text: '<message to="room-b">reply to B</message>' });

    await processQuery(query, ORIGIN_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, originDests);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('room-b'); // not redirected — room-b was in the batch
  });
});

describe('lenient output — unwrapped prose for ollama-backed agents', () => {
  function seedChannel(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }
  const ORIGIN_ROUTING = { platformId: 'room-a', channelType: 'webchat', threadId: null, inReplyTo: 'm1' };

  it('delivers bare prose to the origin room when lenient', async () => {
    seedChannel('room-a', 'webchat', 'room-a');
    const originDests = [findByRouting('webchat', 'room-a')!];
    const { query } = makeResultQuery({ type: 'result', text: 'The answer is 42.' });

    await processQuery(query, ORIGIN_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, originDests, true);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('room-a');
    expect(JSON.parse(out[0].content).text).toBe('The answer is 42.');
  });

  it('drops bare prose (strict protocol) when not lenient', async () => {
    seedChannel('room-a', 'webchat', 'room-a');
    const originDests = [findByRouting('webchat', 'room-a')!];
    const { query } = makeResultQuery({ type: 'result', text: 'just thinking out loud' });

    await processQuery(query, ORIGIN_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, originDests, false);

    expect(getUndeliveredMessages()).toHaveLength(0); // dropped as scratchpad
  });

  it('still honors a proper <message> envelope when lenient (no double send)', async () => {
    seedChannel('room-a', 'webchat', 'room-a');
    const originDests = [findByRouting('webchat', 'room-a')!];
    const { query } = makeResultQuery({ type: 'result', text: '<message to="room-a">wrapped reply</message>' });

    await processQuery(query, ORIGIN_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, originDests, true);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('wrapped reply');
  });

  it('never sends an empty message when the output is purely internal', async () => {
    seedChannel('room-a', 'webchat', 'room-a');
    const originDests = [findByRouting('webchat', 'room-a')!];
    const { query } = makeResultQuery({ type: 'result', text: '<internal>scratch only</internal>' });

    await processQuery(query, ORIGIN_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, originDests, true);

    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

describe('a2a origin — a lenient agent replies to its caller, not a room', () => {
  function seedChannel(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }
  function seedAgent(name: string, agentGroupId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'agent', NULL, NULL, ?)`,
      )
      .run(name, name, agentGroupId);
  }
  // The turn was triggered by an a2a call from 'caller' (channel_type='agent',
  // platform_id = the caller's agent_group_id). The agent is also wired to a room.
  const A2A_ROUTING = { platformId: 'ag-caller', channelType: 'agent', threadId: null, inReplyTo: 'm1' };

  it('lenient: unwrapped prose goes to the a2a caller, not the room', async () => {
    seedChannel('the-room', 'webchat', 'room-x');
    seedAgent('caller', 'ag-caller');
    const originDests = [findByRouting('agent', 'ag-caller')!]; // a2a turn → agent origin only
    const { query } = makeResultQuery({ type: 'result', text: 'Here is the script you asked for.' });

    await processQuery(query, A2A_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, originDests, true);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('agent'); // delivered back to the caller, not webchat
    expect(out[0].platform_id).toBe('ag-caller');
  });

  it('misfire guard: a lone reply addressed to the room is redirected to the caller (lenient)', async () => {
    seedChannel('the-room', 'webchat', 'room-x');
    seedAgent('caller', 'ag-caller');
    const originDests = [findByRouting('agent', 'ag-caller')!];
    const { query } = makeResultQuery({ type: 'result', text: '<message to="the-room">answer</message>' });

    await processQuery(query, A2A_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, originDests, true);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('ag-caller'); // redirected from the-room to the caller
  });

  it('a correct reply addressed to the caller is left alone', async () => {
    seedChannel('the-room', 'webchat', 'room-x');
    seedAgent('caller', 'ag-caller');
    const originDests = [findByRouting('agent', 'ag-caller')!];
    const { query } = makeResultQuery({ type: 'result', text: '<message to="caller">on it</message>' });

    await processQuery(query, A2A_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, originDests, true);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('ag-caller');
  });

  it('non-lenient agent: a deliberate room-post during an a2a turn is NOT redirected', async () => {
    seedChannel('the-room', 'webchat', 'room-x');
    seedAgent('caller', 'ag-caller');
    const originDests = [findByRouting('agent', 'ag-caller')!];
    const { query } = makeResultQuery({ type: 'result', text: '<message to="the-room">posting for you</message>' });

    await processQuery(query, A2A_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, originDests, false);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('webchat'); // strong agent: room-post respected
    expect(out[0].platform_id).toBe('room-x');
  });
});

// --- Task-run turn wiring: the REAL processQuery path (one-door) ---
// These drive the actual call sites (autoAppendTaskLog at result-handling,
// shouldNudgeTaskBlocks gating, and follow-up turn reset). Deleting the wiring
// — not just the helpers — goes red here.

const TASK_ROUTING = {
  platformId: null,
  channelType: null,
  threadId: 'system:tasks:ser-1',
  inReplyTo: 't1',
  taskRun: true,
};

function taskLogRows(): Array<{ text: string }> {
  return (
    getOutboundDb()
      .prepare("SELECT content FROM messages_out WHERE kind = 'task_log' ORDER BY seq")
      .all() as Array<{ content: string }>
  ).map((r) => JSON.parse(r.content) as { text: string });
}

describe('task-run turn wiring (real processQuery)', () => {
  it('auto-appends the final text as a task_log row', async () => {
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'result', text: 'checked feeds — nothing new' };
    }
    const query: AgentQuery = { push: () => {}, end: () => {}, events: events(), abort: () => {} };

    await processQuery(query, TASK_ROUTING, ['t1'], 'claude', undefined, 'prompt', undefined);

    const logs = taskLogRows();
    expect(logs).toHaveLength(1);
    expect(logs[0].text).toBe('checked feeds — nothing new');
    // and nothing was delivered as chat
    expect(getUndeliveredMessages().filter((m) => m.kind === 'chat')).toHaveLength(0);
  });

  it('logs and conditionally nudges a second task run in the same open query', async () => {
    const pushes: string[] = [];

    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      // Turn 1 uses the legacy wrong door and consumes its one correction.
      yield { type: 'result', text: '<message to="local-cli">fire one result</message>' };
      yield { type: 'result', text: 'first delivery decision handled' };

      // A SECOND task run lands while the query is open — the follow-up poller
      // pushes it and must reset the per-turn correction state.
      insertMessage('t2', 'task', { prompt: 'fire two' });
      const deadline = Date.now() + 5000;
      while (!pushes.some((p) => p.includes('fire two')) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }

      // Turn 2 repeats the mistake. This receives a second independent nudge
      // only if the follow-up path reset taskBlockNudged.
      yield { type: 'result', text: '<message to="local-cli">fire two result</message>' };
      yield { type: 'result', text: 'second delivery decision handled' };
    }

    const query: AgentQuery = {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await processQuery(query, TASK_ROUTING, ['t1'], 'claude', undefined, 'prompt', undefined);

    const nudges = pushes.filter((p) => p.includes('If and only if'));
    expect(nudges).toHaveLength(2);
    expect(nudges[0]).toContain('fire one result');
    expect(nudges[1]).toContain('fire two result');

    const logs = taskLogRows().map((l) => l.text);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain('[undelivered → local-cli] fire one result');
    expect(logs[1]).toContain('[undelivered → local-cli] fire two result');
    expect(logs).not.toContain('first delivery decision handled');
    expect(logs).not.toContain('second delivery decision handled');
  });
});
