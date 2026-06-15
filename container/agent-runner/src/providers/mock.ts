import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

/**
 * A factory may return either a plain string (treated as result text, the
 * common case) or a richer descriptor so tests can simulate the graceful-
 * degradation paths:
 *
 *  - `{ result: string | null }` — emit a result with explicit (possibly null /
 *    empty) text, then END the turn (mirrors the real SDK closing after its
 *    result). `null`/empty drives the empty-turn safety net.
 *  - `{ error: {...} }` — emit a terminal error event instead of a result.
 *  - `{ throw: string }` — throw mid-stream (the SDK-died case).
 *  - `{ silent: true }` — emit no result/error at all (pure silence).
 */
export type MockResponse =
  | string
  | { result: string | null }
  | { error: { message: string; retryable?: boolean; classification?: string } }
  | { throw: string }
  | { silent: true };

/**
 * Mock provider for testing. Returns canned responses.
 * Supports push() — queued messages produce additional results.
 */
export class MockProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private responseFactory: (prompt: string, input: QueryInput) => MockResponse;

  constructor(
    _options: ProviderOptions = {},
    responseFactory?: (prompt: string, input: QueryInput) => MockResponse,
  ) {
    this.responseFactory = responseFactory ?? ((prompt) => `Mock response to: ${prompt.slice(0, 100)}`);
  }

  isSessionInvalid(err: unknown): boolean {
    // Mirror the real providers' stale-session detection so tests can exercise
    // the poll-loop's continuation self-heal.
    const msg = err instanceof Error ? err.message : String(err);
    return /no conversation found|session.*not found/i.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    const responseFactory = this.responseFactory;

    // Translate a factory response into the event(s) it represents and a flag:
    // `terminal` means the turn is over and the stream should END (mirroring
    // the real SDK, which closes after an error or a no-text result). Plain
    // result text keeps the stream open for follow-up pushes (legacy behavior
    // the existing integration tests rely on). May throw to simulate a
    // mid-stream SDK failure.
    function* eventsFor(prompt: string): Generator<ProviderEvent, boolean> {
      const resp = responseFactory(prompt, input);
      if (typeof resp === 'string') {
        yield { type: 'result', text: resp };
        return false;
      }
      if ('throw' in resp) {
        throw new Error(resp.throw);
      }
      if ('error' in resp) {
        yield {
          type: 'error',
          message: resp.error.message,
          retryable: resp.error.retryable ?? false,
          classification: resp.error.classification,
        };
        return true;
      }
      if ('silent' in resp) {
        // Pure silence — no result, no error. The turn is over.
        return true;
      }
      // The object `{ result }` form always ends the turn (mirrors the real SDK
      // closing after its result). The bare-string form keeps the stream open
      // for follow-up pushes — the legacy behavior the integration tests use.
      yield { type: 'result', text: resp.result };
      return true;
    }

    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'activity' };
        yield { type: 'init', continuation: `mock-session-${Date.now()}` };

        // Process initial prompt
        yield { type: 'activity' };
        if (yield* eventsFor(input.prompt)) return;

        // Process any pushed follow-ups
        while (!ended && !aborted) {
          if (pending.length > 0) {
            const msg = pending.shift()!;
            if (yield* eventsFor(msg)) return;
            continue;
          }
          // Wait for push() or end()
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }

        // Drain remaining
        while (pending.length > 0) {
          const msg = pending.shift()!;
          if (yield* eventsFor(msg)) return;
        }
      },
    };

    return {
      push(message: string) {
        pending.push(message);
        waiting?.();
      },
      end() {
        ended = true;
        waiting?.();
      },
      events,
      abort() {
        aborted = true;
        waiting?.();
      },
    };
  }
}

registerProvider('mock', (opts) => new MockProvider(opts));
