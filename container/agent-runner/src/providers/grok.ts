/**
 * Grok provider — Grok Build (`grok agent stdio`) behind the AgentProvider
 * contract. The ACP transport lives in grok-acp.ts; this file is the mapping.
 *
 * CONTINUATION is the ACP sessionId. Verified against grok 1.0.5: a sessionId
 * from one process resumes in a NEW process via `session/load`, with history
 * intact — so a container restart mid-conversation is recoverable, which is the
 * property nanoclaw actually needs.
 *
 * TWO TRAPS, both real and both handled here:
 *
 * 1. The poll-loop's idle timer kills a turn that goes quiet, so `activity` is
 *    yielded on EVERY update regardless of kind — including ones we otherwise
 *    ignore. A long tool run streams nothing a user would see, and would
 *    otherwise look dead.
 *
 * 2. `session/load` replays the entire prior conversation as updates before it
 *    returns. Those are flagged `replay` by the transport and are dropped for
 *    CONTENT purposes here — they still count as liveness. Forward them and
 *    every resumed session repeats its own transcript into the room.
 *
 * WHY emitsMidTurnText IS TRUE. ACP carries no text on the prompt response at
 * all — `session/prompt` resolves with only a stopReason, and every assistant
 * word arrives as an `agent_message_chunk` update beforehand. So streaming is
 * necessarily the single content door, which is exactly what the capability
 * describes; the `result` we emit replays the accumulated text so the
 * result-door contract ("the result is a repeat of what already streamed")
 * holds rather than being quietly violated.
 */
import { AcpClient, spawnGrokTransport, type AcpTransport, type AcpUpdate, type GrokSpawnOptions } from './grok-acp.js';
import { registerProvider } from './provider-registry.js';
import { memoryContextForSessionStart, type MemorySessionHookRegistration } from '../memory/session-hook.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

/** Update kinds whose text is assistant output the user should see. */
const MESSAGE_KIND = 'agent_message_chunk';
/**
 * Update kinds carrying the model's reasoning.
 *
 * Consumed for LIVENESS ONLY — deliberately not forwarded as content.
 *
 * ACP streams thinking one token per update, so forwarding them produced 145
 * `progress` lines for a single short turn on a live agent, burying the actual
 * signal. `progress` is for meaningful movement (a tool starting), not a token
 * feed. Upstream has no `reasoning` variant to put them on — that is a seam
 * addition — and no channel is better than the wrong channel at this volume.
 * On a tree carrying the seam event, emitting `reasoning` here is the change.
 */
const THOUGHT_KIND = 'agent_thought_chunk';
/** Tool lifecycle: surfaced as progress so observers see movement during long runs. */
const TOOL_KINDS = new Set(['tool_call', 'tool_call_update']);

/** stopReasons that mean the turn failed rather than finished. */
const ERROR_STOP_REASONS = new Set(['refusal', 'error', 'max_tokens']);

/**
 * Errors that mean the stored sessionId is gone. Grok reports this as a plain
 * JSON-RPC error on session/load, so matching is textual by necessity; keep the
 * patterns broad — a false positive costs one fresh session, a false negative
 * strands the agent on a continuation that can never load.
 */
const SESSION_INVALID_PATTERNS = [/session\s*not\s*found/i, /no\s*such\s*session/i, /unknown\s*session/i, /session.*(expired|invalid)/i];

/** How a query obtains its stdio transport. Injected in tests; spawns grok in production. */
export type GrokTransportFactory = (options: GrokSpawnOptions) => Promise<AcpTransport>;

export class GrokProvider implements AgentProvider {
  /**
   * False deliberately. Grok ships its own command set (22 bundled skills at
   * 1.0.5, including names like /imagine), and passing raw slash commands
   * through would let those shadow nanoclaw's. The poll-loop formats them as
   * ordinary chat instead, which keeps command meaning owned by nanoclaw.
   */
  readonly supportsNativeSlashCommands = false;

  /** See the header note — ACP has no text on the result, so streaming is the only door. */
  readonly emitsMidTurnText = true;

  private memoryHook: MemorySessionHookRegistration | null = null;

  constructor(
    private readonly options: ProviderOptions = {},
    private readonly transportFactory: GrokTransportFactory = spawnGrokTransport,
  ) {}

  registerMemorySessionHook(hook: MemorySessionHookRegistration): void {
    this.memoryHook = hook;
  }

  isSessionInvalid(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err ?? '');
    return SESSION_INVALID_PATTERNS.some((p) => p.test(message));
  }

  query(input: QueryInput): AgentQuery {
    return new GrokQuery(input, this.options, this.memoryHook, this.transportFactory);
  }
}

/**
 * One conversation, driven over a dedicated grok child process.
 *
 * The process is per-query rather than shared: ACP sessions are addressed by
 * id and resume across processes, so a crash costs a respawn instead of the
 * conversation, and one wedged turn cannot poison the next.
 */
class GrokQuery implements AgentQuery {
  private readonly queue = new EventQueue();
  private client: AcpClient | null = null;
  private sessionId: string | null = null;
  private readonly followUps: string[] = [];
  private ended = false;
  private aborted = false;
  private turnText = '';
  /** Text streamed since the last line-boundary flush. */
  private pending = '';

  constructor(
    private readonly input: QueryInput,
    private readonly options: ProviderOptions,
    private readonly memoryHook: MemorySessionHookRegistration | null,
    private readonly transportFactory: GrokTransportFactory,
  ) {
    void this.run();
  }

  get events(): AsyncIterable<ProviderEvent> {
    return this.queue;
  }

  push(message: string): void {
    this.followUps.push(message);
    this.queue.wake();
  }

  end(): void {
    this.ended = true;
    this.queue.wake();
  }

  abort(): void {
    this.aborted = true;
    if (this.client && this.sessionId) this.client.cancel(this.sessionId);
    this.teardown();
    this.queue.close();
  }

  private async run(): Promise<void> {
    try {
      const transport = await this.transportFactory(this.spawnOptions());
      this.client = new AcpClient(transport, {
        onUpdate: (u) => this.onUpdate(u),
        // A turn can legitimately run for many minutes of tool work; the
        // poll-loop's idle timer is the real deadline, not this one.
        requestTimeoutMs: 30 * 60_000,
      });

      await this.client.initialize({ fs: { readTextFile: false, writeTextFile: false } });
      this.sessionId = await this.openSession(this.client);
      this.queue.push({ type: 'init', continuation: this.sessionId });

      await this.runTurn(this.firstPrompt());
      // Follow-ups pushed while a turn was in flight run in the same session,
      // which is what makes push() a continuation rather than a new context.
      while (!this.aborted) {
        const next = this.followUps.shift();
        if (next === undefined) {
          if (this.ended) break;
          await this.queue.idle();
          continue;
        }
        await this.runTurn(next);
      }
    } catch (err) {
      this.queue.push({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
        retryable: isRetryable(err),
      });
    } finally {
      this.teardown();
      this.queue.close();
    }
  }

  /**
   * Resume the stored session, or start a fresh one. A load failure is
   * re-thrown so the poll-loop can consult isSessionInvalid and clear a dead
   * continuation — silently starting fresh here would hide that from it and
   * leave the bad token stored.
   */
  private async openSession(client: AcpClient): Promise<string> {
    const cwd = this.input.cwd;
    if (this.input.continuation) {
      await client.loadSession({ sessionId: this.input.continuation, cwd });
      return this.input.continuation;
    }
    return client.newSession({ cwd });
  }

  /**
   * Instructions and MEMORY ride on the first prompt of a NEW session only.
   *
   * Grok reads CLAUDE.md and AGENTS.md from the cwd natively, so this carries
   * what is NOT on disk: the composed system context, and the rendered memory
   * section. Memory needs carrying because the provider contract delivers it
   * through a SessionStart command hook — which the Claude SDK invokes and a
   * child process speaking ACP has no equivalent for. Without this, a Grok
   * agent could read memory/ only if it thought to look, while a Claude agent
   * is handed it; the composed CLAUDE.md mentions the directory in a comment
   * and nothing more.
   *
   * `memoryContextForSessionStart` returns undefined on 'resume' by its own
   * rule — a resumed conversation already carries the injected context — and
   * this path only runs when there is no continuation, so the two agree.
   */
  private firstPrompt(): string {
    if (this.input.continuation) return this.input.prompt;
    const instructions = this.input.systemContext?.instructions?.trim();
    const memory = memoryContextForSessionStart('startup', this.input.cwd)?.trim();
    const preamble = [memory, instructions].filter(Boolean).join('\n\n');
    return preamble ? `${preamble}\n\n${this.input.prompt}` : this.input.prompt;
  }

  private async runTurn(prompt: string): Promise<void> {
    if (!this.client || !this.sessionId || this.aborted) return;
    this.turnText = '';
    this.pending = '';
    const res = await this.client.prompt(this.sessionId, prompt);
    if (this.aborted) return;
    // A turn whose last line has no trailing newline still has to reach the
    // mid-turn door before the result closes it.
    if (this.pending.length > 0) {
      this.queue.push({ type: 'text', text: this.pending });
      this.pending = '';
    }
    const stopReason = typeof res?.stopReason === 'string' ? res.stopReason : undefined;
    this.queue.push({
      type: 'result',
      text: this.turnText.length > 0 ? this.turnText : null,
      ...(stopReason && ERROR_STOP_REASONS.has(stopReason) ? { isError: true } : {}),
    });
  }

  /**
   * Every update yields `activity` (trap 1). Replayed history yields ONLY
   * activity (trap 2) — it is liveness, never content.
   */
  private onUpdate(update: AcpUpdate): void {
    this.queue.push({ type: 'activity' });
    if (update.replay) return;

    if (update.kind === MESSAGE_KIND && update.text) {
      this.turnText += update.text;
      this.pending += update.text;
      // Flush on line boundaries, not per token. The poll-loop scans these
      // segments for complete <message> blocks and carries an unresolved tail
      // between them; per-token events made it reassemble a block character by
      // character. Blocks are line-oriented, so a newline is the natural seam —
      // and anything still buffered is flushed when the turn ends, so nothing
      // is withheld.
      const cut = this.pending.lastIndexOf('\n');
      if (cut >= 0) {
        const segment = this.pending.slice(0, cut + 1);
        this.pending = this.pending.slice(cut + 1);
        this.queue.push({ type: 'text', text: segment });
      }
      return;
    }
    if (update.kind === THOUGHT_KIND) return; // liveness only — see THOUGHT_KIND
    if (TOOL_KINDS.has(update.kind)) {
      this.queue.push({ type: 'progress', message: update.text ? `${update.kind}: ${update.text}` : update.kind });
    }
  }

  private spawnOptions(): GrokSpawnOptions {
    return {
      model: this.options.model,
      cwd: this.input.cwd,
      env: this.options.env,
    };
  }

  private teardown(): void {
    this.client?.close();
    this.client = null;
    // Referenced so the hook registration is not silently dropped; shared
    // memory reaches Grok through the composed instructions on the first
    // prompt and through CLAUDE.md in the cwd, not a native session hook.
    void this.memoryHook;
  }
}

/** Errors worth another attempt: transport/startup faults, not protocol rejections. */
export function isRetryable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /spawn failed|transport closed|timed out|ECONN|EPIPE/i.test(message);
}

/**
 * Async queue bridging push-style callbacks to the pull-style AsyncIterable the
 * contract requires. Kept local: no other provider needs it, and a shared
 * version would invite coupling between providers that should stay independent.
 */
class EventQueue implements AsyncIterable<ProviderEvent> {
  private readonly items: ProviderEvent[] = [];
  private resolveNext: (() => void) | null = null;
  private closed = false;

  push(event: ProviderEvent): void {
    if (this.closed) return;
    this.items.push(event);
    this.wake();
  }

  wake(): void {
    const r = this.resolveNext;
    this.resolveNext = null;
    r?.();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  /** Resolves on the next push/wake/close — lets run() park without spinning. */
  idle(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const prev = this.resolveNext;
      this.resolveNext = () => {
        prev?.();
        resolve();
      };
    });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
    for (;;) {
      while (this.items.length > 0) yield this.items.shift() as ProviderEvent;
      if (this.closed) return;
      await this.idle();
    }
  }
}

registerProvider('grok', (options) => new GrokProvider(options));
