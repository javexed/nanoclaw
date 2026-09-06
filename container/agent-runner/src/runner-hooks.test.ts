import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './mailbox/sqlite/connection.js';
import { runPollLoop, type PollLoopConfig } from './poll-loop.js';
import { MockProvider } from './providers/mock.js';
import { registerProviderExchangeObserver, __snapshotProviderHooksForTest } from './providers/hooks.js';
import {
  registerRunnerCommand,
  registerTurnCompletionObserver,
  registerTurnRetryHandler,
  runTurnRetryHandlers,
  matchRunnerCommand,
  classifyRunnerCommand,
  runDeferredRunnerCommand,
  notifyTurnCompletion,
  __snapshotRunnerHooksForTest,
  type RunnerTurnContext,
} from './runner-hooks.js';
import type { ProviderExchange } from './providers/types.js';

let restoreRunnerHooks: () => void;
let restoreProviderHooks: () => void;

beforeEach(() => {
  initTestSessionDb();
  restoreRunnerHooks = __snapshotRunnerHooksForTest();
  restoreProviderHooks = __snapshotProviderHooksForTest();
});

afterEach(() => {
  restoreRunnerHooks();
  restoreProviderHooks();
  closeSessionDb();
});

function insertMessage(id: string, kind: string, content: object) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, trigger, on_wake, content)
       VALUES (?, ?, datetime('now'), 'pending', 1, 0, ?)`,
    )
    .run(id, kind, JSON.stringify(content));
}

// Completion is acked cross-DB: the container writes processing_ack in the
// OUTBOUND db and the host syncs inbound status (two-DB split). Read the ack.
function ackStatus(id: string): string | null {
  const row = getOutboundDb().prepare(`SELECT status FROM processing_ack WHERE message_id = ?`).get(id) as
    | { status: string }
    | undefined;
  return row?.status ?? null;
}

// Run the loop until `until()` holds (or ~2s worst case), mirroring the
// integration suite's abort-race teardown.
async function runLoopUntil(config: Omit<PollLoopConfig, 'signal'>, until: () => boolean): Promise<void> {
  const controller = new AbortController();
  const loopPromise = Promise.race([
    runPollLoop({ ...config, signal: controller.signal }),
    new Promise<void>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
  ]).catch(() => {});
  const start = Date.now();
  while (!until() && Date.now() - start < 2000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  controller.abort();
  await loopPromise;
}

const fakeCtx = (): RunnerTurnContext => ({
  routing: { platformId: null, channelType: null, threadId: null, inReplyTo: null, taskRun: false },
  batchMessages: [],
  getContinuation: () => undefined,
  config: { provider: new MockProvider(), providerName: 'mock', cwd: '/tmp' },
});

describe('runner command registry (unit)', () => {
  it('matchRunnerCommand returns the first matching spec and skips throwing matchers', () => {
    registerRunnerCommand({
      matches: () => {
        throw new Error('buggy matcher');
      },
      classify: () => ({ action: 'defer' }),
    });
    const spec = {
      matches: (text: string) => text.startsWith('/mycmd'),
      classify: () => ({ action: 'defer' }) as const,
    };
    registerRunnerCommand(spec);
    expect(matchRunnerCommand('/mycmd now')).toBe(spec);
    expect(matchRunnerCommand('/other')).toBeNull();
  });

  it('classifyRunnerCommand returns null when classify throws', () => {
    const spec = {
      matches: () => true,
      classify: () => {
        throw new Error('boom');
      },
    };
    expect(classifyRunnerCommand(spec, '/x', { provider: new MockProvider() })).toBeNull();
  });

  it('runDeferredRunnerCommand awaits execute and swallows its errors', async () => {
    const calls: string[] = [];
    await runDeferredRunnerCommand(
      {
        matches: () => true,
        classify: () => ({ action: 'defer' }),
        execute: async (text) => {
          calls.push(text);
          throw new Error('execute bug');
        },
      },
      '/x arg',
      fakeCtx(),
    );
    expect(calls).toEqual(['/x arg']);
    // No execute() at all is a no-op.
    await runDeferredRunnerCommand({ matches: () => true, classify: () => ({ action: 'defer' }) }, '/x', fakeCtx());
  });

  it('notifyTurnCompletion isolates a throwing observer', () => {
    const seen: RunnerTurnContext[] = [];
    registerTurnCompletionObserver(() => {
      throw new Error('observer bug');
    });
    registerTurnCompletionObserver((ctx) => seen.push(ctx));
    const ctx = fakeCtx();
    notifyTurnCompletion(ctx);
    expect(seen).toEqual([ctx]);
  });
});

describe('runner command registry (poll loop)', () => {
  it('defer consumes the row without a query and runs execute() at the idle point', async () => {
    const executed: Array<{ text: string; continuation: string | undefined }> = [];
    registerRunnerCommand({
      matches: (text) => /^\/testcmd\b/i.test(text),
      classify: () => ({ action: 'defer' }),
      execute: async (text, ctx) => {
        executed.push({ text: text, continuation: ctx.getContinuation() });
      },
    });

    const prompts: string[] = [];
    const provider = new MockProvider({}, (prompt) => {
      prompts.push(prompt);
      return 'ok';
    });

    insertMessage('cmd-1', 'chat', { sender: 'John', text: '/testcmd focus on requests' });
    await runLoopUntil({ provider, providerName: 'mock', cwd: '/tmp' }, () => executed.length > 0);

    expect(executed).toHaveLength(1);
    expect(executed[0].text).toBe('/testcmd focus on requests');
    expect(ackStatus('cmd-1')).toBe('completed');
    // The command was consumed — no provider query ran for it.
    expect(prompts).toHaveLength(0);
  });

  it('rewrite keeps the row in the batch with replaced text', async () => {
    registerRunnerCommand({
      matches: (text) => /^\/testcmd\b/i.test(text),
      classify: (text) => ({ action: 'rewrite', text: `REWRITTEN(${text})` }),
    });

    const prompts: string[] = [];
    const provider = new MockProvider({}, (prompt) => {
      prompts.push(prompt);
      return 'ok';
    });

    insertMessage('cmd-2', 'chat', { sender: 'John', text: '/testcmd inline' });
    await runLoopUntil({ provider, providerName: 'mock', cwd: '/tmp' }, () => prompts.length > 0);

    expect(prompts.join('\n')).toContain('REWRITTEN(/testcmd inline)');
  });

  it('a throwing classify() lets the row flow through as a normal message', async () => {
    registerRunnerCommand({
      matches: (text) => /^\/testcmd\b/i.test(text),
      classify: () => {
        throw new Error('classify bug');
      },
    });

    const prompts: string[] = [];
    const provider = new MockProvider({}, (prompt) => {
      prompts.push(prompt);
      return 'ok';
    });

    insertMessage('cmd-3', 'chat', { sender: 'John', text: '/testcmd broken' });
    await runLoopUntil({ provider, providerName: 'mock', cwd: '/tmp' }, () => prompts.length > 0);

    expect(prompts.join('\n')).toContain('/testcmd broken');
  });

  it('built-ins win: /clear is not offered to the registry', async () => {
    let offered = 0;
    registerRunnerCommand({
      matches: () => {
        offered += 1;
        return false;
      },
      classify: () => ({ action: 'defer' }),
    });

    insertMessage('cmd-4', 'chat', { sender: 'John', text: '/clear' });
    await runLoopUntil(
      { provider: new MockProvider(), providerName: 'mock', cwd: '/tmp' },
      () => ackStatus('cmd-4') === 'completed',
    );

    expect(ackStatus('cmd-4')).toBe('completed');
    expect(offered).toBe(0);
  });
});

describe('turn-completion + exchange observers (poll loop)', () => {
  it('notifies turn observers with the batch context at each result', async () => {
    const seen: RunnerTurnContext[] = [];
    registerTurnCompletionObserver((ctx) => seen.push(ctx));

    insertMessage('t-1', 'chat', { sender: 'John', text: 'hello there' });
    await runLoopUntil({ provider: new MockProvider(), providerName: 'mock', cwd: '/tmp' }, () => seen.length > 0);

    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0].batchMessages.map((m) => m.id)).toContain('t-1');
    expect(seen[0].config.providerName).toBe('mock');
    // Lazy continuation: the ctx reads the loop's CURRENT value, so once the
    // loop has stored a continuation the same ctx object sees it — and it can
    // only ever be the mock's session id, never a stale snapshot.
    const cont = seen[0].getContinuation();
    if (cont !== undefined) expect(cont).toStartWith('mock-session-');
  });

  it('notifies exchange observers alongside the provider hook', async () => {
    const exchanges: ProviderExchange[] = [];
    registerProviderExchangeObserver((ex) => exchanges.push(ex));

    insertMessage('t-2', 'chat', { sender: 'John', text: 'ping' });
    await runLoopUntil({ provider: new MockProvider(), providerName: 'mock', cwd: '/tmp' }, () => exchanges.length > 0);

    expect(exchanges.length).toBeGreaterThanOrEqual(1);
    expect(exchanges[0].prompt).toContain('ping');
    expect(exchanges[0].result).toContain('Mock response');
  });
});

describe('turn-retry handlers (R5)', () => {
  it('first non-null claims the failure; throwing handlers are skipped', async () => {
    restoreRunnerHooks = __snapshotRunnerHooksForTest();
    const calls: string[] = [];
    registerTurnRetryHandler(async () => {
      calls.push('throws');
      throw new Error('handler bug');
    });
    registerTurnRetryHandler(async () => {
      calls.push('declines');
      return null;
    });
    registerTurnRetryHandler(async () => {
      calls.push('claims');
      return { continuation: 'retry-session' };
    });
    registerTurnRetryHandler(async () => {
      calls.push('never');
      return { continuation: 'nope' };
    });

    const out = await runTurnRetryHandlers({
      failure: { message: 'primary exploded' },
      prompt: 'p',
      routing: { platformId: null, channelType: null, threadId: null, inReplyTo: null, taskRun: false },
      config: { provider: new MockProvider(), providerName: 'mock', cwd: '/tmp' },
      retryWith: async () => null,
    });

    expect(out).toEqual({ continuation: 'retry-session' });
    expect(calls).toEqual(['throws', 'declines', 'claims']);
  });

  it('returns null when nobody claims — core falls through to its error path', async () => {
    restoreRunnerHooks = __snapshotRunnerHooksForTest();
    registerTurnRetryHandler(async () => null);
    const out = await runTurnRetryHandlers({
      failure: { message: 'boom', classification: 'network' },
      prompt: 'p',
      routing: { platformId: null, channelType: null, threadId: null, inReplyTo: null, taskRun: false },
      config: { provider: new MockProvider(), providerName: 'mock', cwd: '/tmp' },
      retryWith: async () => null,
    });
    expect(out).toBeNull();
  });

  it('a handler can cap its own spend across turns (the documented pattern)', async () => {
    restoreRunnerHooks = __snapshotRunnerHooksForTest();
    // Module-scope streak + cap: exactly what an escalating module must do,
    // since core cannot know what a retry costs.
    let consecutive = 0;
    const CAP = 2;
    const attempted: number[] = [];
    registerTurnRetryHandler(async (ctx) => {
      if (consecutive >= CAP) return null; // over cap → let the error surface
      consecutive += 1;
      attempted.push(consecutive);
      return await ctx.retryWith(new MockProvider(), 'fallback');
    });

    const ctxBase = {
      failure: { message: 'primary failed' },
      prompt: 'p',
      routing: { platformId: null, channelType: null, threadId: null, inReplyTo: null, taskRun: false },
      config: { provider: new MockProvider(), providerName: 'mock', cwd: '/tmp' },
      retryWith: async () => ({ continuation: 'fallback-session' }),
    };
    expect(await runTurnRetryHandlers(ctxBase)).toEqual({ continuation: 'fallback-session' });
    expect(await runTurnRetryHandlers(ctxBase)).toEqual({ continuation: 'fallback-session' });
    // third consecutive failure is over the cap — no retry, error surfaces
    expect(await runTurnRetryHandlers(ctxBase)).toBeNull();
    expect(attempted).toEqual([1, 2]);
  });
});
