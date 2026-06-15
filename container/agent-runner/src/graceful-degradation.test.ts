import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { setContinuation, getContinuation } from './db/session-state.js';
import { MockProvider } from './providers/mock.js';
import { classifyTerminalError } from './providers/claude.js';
import { runPollLoop } from './poll-loop.js';

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(id: string, content: object) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
       VALUES (?, 'chat', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
    )
    .run(id, JSON.stringify(content));
}

async function runUntil(provider: MockProvider, condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const controller = new AbortController();
  const loop = Promise.race([
    runPollLoop({ provider, providerName: 'mock', cwd: '/tmp' }),
    new Promise<void>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs - 200) break;
    await new Promise((r) => setTimeout(r, 30));
  }
  controller.abort();
  await loop.catch(() => {});
}

// ── C: classifyTerminalError mapping ──

describe('classifyTerminalError', () => {
  it('maps model/config rejections to "config"', () => {
    expect(classifyTerminalError('Model not found: llama3')).toBe('config');
    expect(classifyTerminalError('invalid model identifier')).toBe('config');
    expect(classifyTerminalError('HTTP 404 Not Found')).toBe('config');
    expect(classifyTerminalError('401 Unauthorized')).toBe('config');
    expect(classifyTerminalError('unauthorized')).toBe('config');
    expect(classifyTerminalError('the model was rejected by the backend')).toBe('config');
    expect(classifyTerminalError('model "foo" does not exist')).toBe('config');
  });

  it('maps connection failures to "network"', () => {
    expect(classifyTerminalError('connect ECONNREFUSED 127.0.0.1:11434')).toBe('network');
    expect(classifyTerminalError('connection refused')).toBe('network');
    expect(classifyTerminalError('fetch failed')).toBe('network');
    expect(classifyTerminalError('request ETIMEDOUT')).toBe('network');
  });

  it('returns undefined for unclassified errors', () => {
    expect(classifyTerminalError('some unexpected internal failure')).toBeUndefined();
    expect(classifyTerminalError('')).toBeUndefined();
  });
});

// ── A: non-quota terminal error is surfaced to the user ──

describe('poll loop — non-quota terminal error surfacing (A)', () => {
  it('writes a user-facing message for a network error', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hi' });
    const provider = new MockProvider({}, () => ({
      error: { message: 'connect ECONNREFUSED 127.0.0.1:11434', retryable: false, classification: 'network' },
    }));

    await runUntil(provider, () => getUndeliveredMessages().length > 0);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const text = JSON.parse(out[0].content).text as string;
    expect(text).toContain('reach the model backend');
    expect(text).toContain('ECONNREFUSED');
  });

  it('surfaces a config model error with admin guidance', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hi' });
    const provider = new MockProvider({}, () => ({
      error: { message: 'Model not found: llama3', retryable: false, classification: 'config' },
    }));

    await runUntil(provider, () => getUndeliveredMessages().length > 0);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toContain('model setting');
  });

  it('surfaces an unclassified error verbatim', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hi' });
    const provider = new MockProvider({}, () => ({
      error: { message: 'kaboom', retryable: false },
    }));

    await runUntil(provider, () => getUndeliveredMessages().length > 0);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toContain('kaboom');
  });

  it('surfaces an error thrown mid-stream by the provider', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hi' });
    const provider = new MockProvider({}, () => ({ throw: 'connection refused by backend' }));

    await runUntil(provider, () => getUndeliveredMessages().length > 0);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toContain('connection refused');
  });
});

// ── B: empty-turn safety net ──

describe('poll loop — empty-turn safety net (B)', () => {
  it('writes the fallback message when a turn produces a null result', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hi' });
    // Mock emits a result with null text and then ends — no MCP send, no error.
    const provider = new MockProvider({}, () => ({ result: null }));

    await runUntil(provider, () => getUndeliveredMessages().length > 0);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toContain("wasn't able to produce a response");
  });

  it('writes the fallback message when a turn is completely silent', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hi' });
    const provider = new MockProvider({}, () => ({ silent: true }));

    await runUntil(provider, () => getUndeliveredMessages().length > 0);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toContain("wasn't able to produce a response");
  });

  it('does NOT fire the safety net for a normal productive turn', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hi' });
    const provider = new MockProvider({}, () => ({ result: '<message to="discord-test">all good</message>' }));

    await runUntil(provider, () => getUndeliveredMessages().length > 0);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('all good');
  });
});

// ── D: stale-continuation self-heal ──

describe('poll loop — stale-continuation self-heal (D)', () => {
  it('clears a dead continuation and retries fresh instead of erroring every turn', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hi' });
    // A continuation is on file but the provider will reject it as "not found".
    setContinuation('mock', 'dead-session-xyz');
    // First turn resumes the dead id → terminal error. The retry runs with no
    // continuation → a clean productive turn.
    const provider = new MockProvider({}, (_prompt, input) =>
      input.continuation
        ? { error: { message: `No conversation found with session ID: ${input.continuation}`, retryable: false } }
        : { result: '<message to="discord-test">recovered</message>' },
    );

    await runUntil(provider, () => getUndeliveredMessages().length > 0);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const text = JSON.parse(out[0].content).text as string;
    // Healed: the user sees the real reply, not the "Something went wrong" error.
    expect(text).toBe('recovered');
    expect(text).not.toContain('Something went wrong');
    // The dead continuation was cleared and replaced by the fresh session id.
    const healed = getContinuation('mock');
    expect(healed).toBeDefined();
    expect(healed).not.toBe('dead-session-xyz');
  });

  it('still surfaces a terminal error that is NOT a stale-session error', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hi' });
    setContinuation('mock', 'some-session');
    // A non-session error must not trigger the retry — it surfaces as before.
    const provider = new MockProvider({}, () => ({
      error: { message: 'connect ECONNREFUSED', retryable: false, classification: 'network' },
    }));

    await runUntil(provider, () => getUndeliveredMessages().length > 0);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toContain('reach the model backend');
  });
});
