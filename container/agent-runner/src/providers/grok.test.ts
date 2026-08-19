/**
 * GrokProvider — ACP updates mapped onto ProviderEvent.
 *
 * The two cases worth pinning are the ones that cost real behaviour if wrong:
 * `activity` on EVERY update (the poll-loop's idle timer kills quiet turns),
 * and replayed history counting as liveness but never as content.
 */
import { describe, it, expect } from 'bun:test';

import { GrokProvider, isRetryable } from './grok.js';
import type { AcpTransport } from './grok-acp.js';
import type { ProviderEvent } from './types.js';

/** A scripted ACP agent: answers our requests, emits the updates we tell it to. */
function scriptedAgent(script: {
  sessionId?: string;
  loadFails?: string;
  /** Updates emitted during session/load — i.e. history replay. */
  replayUpdates?: Record<string, unknown>[];
  /** Updates emitted per prompt turn, in order of turn. */
  turns?: Record<string, unknown>[][];
  stopReason?: string;
}) {
  let onLine: (line: string) => void = () => {};
  let turnIndex = 0;

  const emit = (msg: unknown) => onLine(JSON.stringify(msg) + '\n');
  const update = (u: Record<string, unknown>) => emit({ jsonrpc: '2.0', method: 'session/update', params: { update: u } });

  const transport: AcpTransport = {
    write(line) {
      const msg = JSON.parse(line) as { id?: number; method?: string };
      if (msg.method === 'initialize') return emit({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      if (msg.method === 'session/new')
        return emit({ jsonrpc: '2.0', id: msg.id, result: { sessionId: script.sessionId ?? 'sess-new' } });
      if (msg.method === 'session/load') {
        if (script.loadFails) return emit({ jsonrpc: '2.0', id: msg.id, error: { message: script.loadFails } });
        for (const u of script.replayUpdates ?? []) update(u);
        return emit({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
      if (msg.method === 'session/prompt') {
        for (const u of script.turns?.[turnIndex] ?? []) update(u);
        turnIndex += 1;
        return emit({ jsonrpc: '2.0', id: msg.id, result: { stopReason: script.stopReason ?? 'end_turn' } });
      }
    },
    onLine: (h) => void (onLine = h),
    onClose: () => {},
    close: () => {},
  };
  return async () => transport;
}

const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { text } });
const thought = (text: string) => ({ sessionUpdate: 'agent_thought_chunk', content: { text } });

async function collect(query: { events: AsyncIterable<ProviderEvent> }, opts?: { stopAfterResult?: boolean }) {
  const events: ProviderEvent[] = [];
  for await (const e of query.events) {
    events.push(e);
    if (opts?.stopAfterResult && e.type === 'result') break;
  }
  return events;
}

describe('GrokProvider capabilities', () => {
  it('declares mid-turn text as the content door, and does not claim native slash commands', () => {
    const p = new GrokProvider({}, scriptedAgent({}));
    expect(p.emitsMidTurnText).toBe(true);
    // Grok ships its own /commands; letting them shadow nanoclaw's would be a regression.
    expect(p.supportsNativeSlashCommands).toBe(false);
  });
});

describe('sessions and continuation', () => {
  it('a fresh query emits init with the new sessionId', async () => {
    const p = new GrokProvider({}, scriptedAgent({ sessionId: 'sess-A', turns: [[chunk('hi')]] }));
    const q = p.query({ prompt: 'hello', cwd: '/w' });
    const events = await collect(q, { stopAfterResult: true });
    q.abort();
    expect(events[0]).toEqual({ type: 'init', continuation: 'sess-A' });
  });

  it('a continuation resumes that session and reports the same id', async () => {
    const p = new GrokProvider({}, scriptedAgent({ turns: [[chunk('resumed')]] }));
    const q = p.query({ prompt: 'again', cwd: '/w', continuation: 'sess-prior' });
    const events = await collect(q, { stopAfterResult: true });
    q.abort();
    expect(events[0]).toEqual({ type: 'init', continuation: 'sess-prior' });
  });

  it('a failed load surfaces as an error event so the loop can clear the continuation', async () => {
    const p = new GrokProvider({}, scriptedAgent({ loadFails: 'session not found' }));
    const q = p.query({ prompt: 'x', cwd: '/w', continuation: 'dead' });
    const events = await collect(q);
    const err = events.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    expect(p.isSessionInvalid(new Error((err as { message: string }).message))).toBe(true);
  });
});

describe('content mapping', () => {
  it('streams text chunks and replays them as the result text', async () => {
    const p = new GrokProvider({}, scriptedAgent({ turns: [[chunk('3'), chunk('9'), chunk('1')]] }));
    const q = p.query({ prompt: '17*23', cwd: '/w' });
    const events = await collect(q, { stopAfterResult: true });
    q.abort();

    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)).toEqual(['3', '9', '1']);
    expect(events.at(-1)).toEqual({ type: 'result', text: '391' });
  });

  it('a turn that produced no text results in null, not an empty string', async () => {
    const p = new GrokProvider({}, scriptedAgent({ turns: [[]] }));
    const q = p.query({ prompt: 'x', cwd: '/w' });
    const events = await collect(q, { stopAfterResult: true });
    q.abort();
    expect(events.at(-1)).toEqual({ type: 'result', text: null });
  });

  it('thoughts and tool calls become progress, not user-visible text', async () => {
    const p = new GrokProvider(
      {},
      scriptedAgent({ turns: [[thought('thinking…'), { sessionUpdate: 'tool_call', title: 'run_terminal_command' }, chunk('done')]] }),
    );
    const q = p.query({ prompt: 'x', cwd: '/w' });
    const events = await collect(q, { stopAfterResult: true });
    q.abort();

    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)).toEqual(['done']);
    const progress = events.filter((e) => e.type === 'progress').map((e) => (e as { message: string }).message);
    expect(progress).toContain('thinking…');
    expect(progress.some((m) => m.includes('run_terminal_command'))).toBe(true);
  });

  it('an error stopReason marks the result, so the loop surfaces it', async () => {
    const p = new GrokProvider({}, scriptedAgent({ turns: [[chunk('nope')]], stopReason: 'refusal' }));
    const q = p.query({ prompt: 'x', cwd: '/w' });
    const events = await collect(q, { stopAfterResult: true });
    q.abort();
    expect(events.at(-1)).toEqual({ type: 'result', text: 'nope', isError: true });
  });
});

describe('the two traps', () => {
  it('yields activity on EVERY update, including ones it otherwise ignores', async () => {
    const p = new GrokProvider(
      {},
      scriptedAgent({ turns: [[{ sessionUpdate: 'available_commands_update' }, thought('t'), chunk('a')]] }),
    );
    const q = p.query({ prompt: 'x', cwd: '/w' });
    const events = await collect(q, { stopAfterResult: true });
    q.abort();
    // Three updates in, three activity events out — a quiet tool run must not look dead.
    expect(events.filter((e) => e.type === 'activity')).toHaveLength(3);
  });

  it('replayed history is liveness only — never text', async () => {
    const p = new GrokProvider(
      {},
      scriptedAgent({
        replayUpdates: [chunk('OLD TURN ONE'), chunk('OLD TURN TWO')],
        turns: [[chunk('fresh')]],
      }),
    );
    const q = p.query({ prompt: 'x', cwd: '/w', continuation: 'sess-prior' });
    const events = await collect(q, { stopAfterResult: true });
    q.abort();

    const text = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text);
    expect(text).toEqual(['fresh']);
    expect(text.join('')).not.toContain('OLD TURN');
    // …but the replayed updates still counted as liveness: 2 replay + 1 live.
    expect(events.filter((e) => e.type === 'activity')).toHaveLength(3);
    expect(events.at(-1)).toEqual({ type: 'result', text: 'fresh' });
  });
});

describe('follow-ups and lifecycle', () => {
  it('push() runs a second turn in the SAME session', async () => {
    const p = new GrokProvider({}, scriptedAgent({ sessionId: 'sess-A', turns: [[chunk('one')], [chunk('two')]] }));
    const q = p.query({ prompt: 'first', cwd: '/w' });

    const events: ProviderEvent[] = [];
    let results = 0;
    for await (const e of q.events) {
      events.push(e);
      if (e.type === 'result') {
        results += 1;
        if (results === 1) q.push('second');
        else break;
      }
    }
    q.abort();

    const inits = events.filter((e) => e.type === 'init');
    expect(inits).toHaveLength(1); // one session, two turns
    expect(events.filter((e) => e.type === 'result').map((e) => (e as { text: string }).text)).toEqual(['one', 'two']);
  });

  it('systemContext rides the first prompt of a new session but not a resume', async () => {
    const prompts: string[] = [];
    const spy = (sessionId?: string) => async (): Promise<AcpTransport> => {
      let onLine: (l: string) => void = () => {};
      return {
        write(line) {
          const m = JSON.parse(line) as { id?: number; method?: string; params?: { prompt?: { text: string }[] } };
          if (m.method === 'session/prompt') prompts.push(m.params?.prompt?.[0]?.text ?? '');
          const result =
            m.method === 'session/new' ? { sessionId: sessionId ?? 's' } : m.method === 'session/prompt' ? { stopReason: 'end_turn' } : {};
          onLine(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
        },
        onLine: (h) => void (onLine = h),
        onClose: () => {},
        close: () => {},
      };
    };

    const fresh = new GrokProvider({}, spy()).query({
      prompt: 'ask', cwd: '/w', systemContext: { instructions: 'BE TERSE' },
    });
    await collect(fresh, { stopAfterResult: true });
    fresh.abort();

    const resumed = new GrokProvider({}, spy()).query({
      prompt: 'ask', cwd: '/w', continuation: 'prior', systemContext: { instructions: 'BE TERSE' },
    });
    await collect(resumed, { stopAfterResult: true });
    resumed.abort();

    expect(prompts[0]).toBe('BE TERSE\n\nask');
    expect(prompts[1]).toBe('ask'); // already in history; repeating it only costs tokens
  });
});

describe('error classification', () => {
  it('isSessionInvalid recognises the dead-continuation shapes', () => {
    const p = new GrokProvider({}, scriptedAgent({}));
    for (const m of ['session not found', 'no such session', 'Unknown session xyz', 'session has expired']) {
      expect(p.isSessionInvalid(new Error(m))).toBe(true);
    }
    expect(p.isSessionInvalid(new Error('rate limited'))).toBe(false);
    expect(p.isSessionInvalid(null)).toBe(false);
  });

  it('isRetryable separates transport faults from protocol rejections', () => {
    expect(isRetryable(new Error('spawn failed: ENOENT'))).toBe(true);
    expect(isRetryable(new Error('ACP transport closed (exit code 1)'))).toBe(true);
    expect(isRetryable(new Error('session/prompt: {"message":"refused"}'))).toBe(false);
  });
});

describe('binary resolution', () => {
  it('spawns via PATH, never from under the mounted grok home', async () => {
    // Regression: the first cut defaulted to $HOME/.grok/bin/grok — the exact
    // path the provider's own mount empties. Live smoke died with ENOENT there.
    const { spawnGrokTransport } = await import('./grok-acp.js');
    let seenBin = '';
    const fakeSpawn = ((bin: string) => {
      seenBin = bin;
      return {
        stdin: { write: () => {} },
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: () => {},
        killed: false,
        kill: () => {},
      };
    }) as unknown as typeof import('node:child_process').spawn;

    await spawnGrokTransport({ spawnFn: fakeSpawn });
    expect(seenBin).toBe('grok');
    expect(seenBin).not.toContain('.grok/bin');
  });
});
