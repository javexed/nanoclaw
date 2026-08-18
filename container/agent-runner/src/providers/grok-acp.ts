/**
 * ACP (Agent Client Protocol) client for Grok Build's `grok agent stdio`.
 *
 * Grok speaks JSON-RPC 2.0 over stdin/stdout, one JSON object per line — the
 * same shape of integration as codex's app-server. This module is the
 * TRANSPORT ONLY: framing, request/response correlation, agent→client requests,
 * and update fan-out. Mapping ACP updates onto ProviderEvent lives in grok.ts,
 * so this file can be tested against a fake stdio peer with no child process
 * and no network.
 *
 * TWO BEHAVIOURS HERE ARE LOAD-BEARING, both measured against grok 1.0.5 rather
 * than read off a spec:
 *
 * 1. `session/load` REPLAYS the entire prior conversation as `session/update`
 *    notifications before its response returns. A consumer that forwards those
 *    blindly makes every resumed session repeat its own transcript into the
 *    room. So updates carry `replay: true` for exactly that window, and the
 *    provider can drop them while still counting them as liveness.
 *
 * 2. The agent sends REQUESTS to us (permission prompts), not just
 *    notifications. An unanswered request hangs the turn forever. We always
 *    answer — `--always-approve` means we never actually see one in practice,
 *    but a build without that flag must not deadlock.
 */

/** One line of newline-delimited JSON, in either direction. */
export interface AcpTransport {
  /** Write one framed line (the newline is added here, not by the caller). */
  write(line: string): void;
  /** Register the line reader. Called once, before any write. */
  onLine(handler: (line: string) => void): void;
  /** Register a transport-death handler (process exit, stream close). */
  onClose(handler: (reason: string) => void): void;
  /** Tear the transport down. Must be idempotent. */
  close(): void;
}

export interface AcpUpdate {
  /** ACP's discriminator: agent_message_chunk, agent_thought_chunk, tool_call, … */
  kind: string;
  /** Text carried by the update, when it carries any. */
  text?: string;
  /** True while `session/load` is replaying history — see note 1 above. */
  replay: boolean;
  /** The untouched `params.update`, for anything the mapper needs later. */
  raw: Record<string, unknown>;
}

export interface AcpPermissionRequest {
  method: string;
  options: Array<{ optionId?: string; kind?: string; name?: string }>;
}

export interface AcpClientOptions {
  /** Called for every session/update notification. */
  onUpdate?: (update: AcpUpdate) => void;
  /**
   * Chooses a permission option. Defaults to the first allow-shaped option, so
   * an agent that asks is never left waiting on a human who isn't there.
   */
  onPermission?: (req: AcpPermissionRequest) => string;
  /** Per-request ceiling. A prompt can legitimately run for minutes. */
  requestTimeoutMs?: number;
}

export interface AcpInitializeResult {
  protocolVersion?: number;
  agentCapabilities?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface AcpPromptResult {
  stopReason?: string;
  [k: string]: unknown;
}

/** The ACP protocol version this client implements. */
export const ACP_PROTOCOL_VERSION = 1;

const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  method: string;
  timer: ReturnType<typeof setTimeout>;
};

export class AcpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffered = '';
  private replayDepth = 0;
  private closed = false;
  private closeReason: string | null = null;

  constructor(
    private readonly transport: AcpTransport,
    private readonly options: AcpClientOptions = {},
  ) {
    transport.onLine((line) => this.handleLine(line));
    transport.onClose((reason) => this.handleClose(reason));
  }

  /** ACP handshake. Must be the first call. */
  initialize(clientCapabilities: Record<string, unknown> = {}): Promise<AcpInitializeResult> {
    return this.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities,
    }) as Promise<AcpInitializeResult>;
  }

  /** Start a fresh conversation. Returns the sessionId used as our continuation. */
  async newSession(params: { cwd: string; mcpServers?: unknown[] }): Promise<string> {
    const res = (await this.request('session/new', {
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
    })) as { sessionId?: string; session_id?: string };
    const id = res?.sessionId ?? res?.session_id;
    if (!id) throw new Error('session/new returned no sessionId');
    return id;
  }

  /**
   * Resume a prior conversation. Updates emitted while this is in flight are
   * history replay, not new output, and are flagged `replay: true`.
   *
   * The window is depth-counted rather than a boolean so concurrent loads (or a
   * load racing a prompt) cannot clear each other's flag early.
   */
  async loadSession(params: { sessionId: string; cwd: string; mcpServers?: unknown[] }): Promise<void> {
    this.replayDepth += 1;
    try {
      await this.request('session/load', {
        sessionId: params.sessionId,
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
      });
    } finally {
      this.replayDepth -= 1;
    }
  }

  /** Send a turn and resolve when it stops. Updates arrive via onUpdate meanwhile. */
  prompt(sessionId: string, text: string): Promise<AcpPromptResult> {
    return this.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    }) as Promise<AcpPromptResult>;
  }

  /** Best-effort cancel. Fire-and-forget: the agent answers by ending the turn. */
  cancel(sessionId: string): void {
    if (this.closed) return;
    this.notify('session/cancel', { sessionId });
  }

  /** Tear down, failing every in-flight request. Idempotent. */
  close(): void {
    this.handleClose('closed by client');
    this.transport.close();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error(`ACP transport closed (${this.closeReason ?? 'unknown'}): ${method}`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request timed out after ${this.timeoutMs}ms: ${method}`));
      }, this.timeoutMs);
      // Never let a pending timer hold the runtime open on its own.
      (timer as unknown as { unref?: () => void }).unref?.();
      this.pending.set(id, { resolve, reject, method, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private get timeoutMs(): number {
    return this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private send(message: unknown): void {
    this.transport.write(JSON.stringify(message));
  }

  /** Accumulate bytes and dispatch on newline. Chunks split anywhere. */
  private handleLine(chunk: string): void {
    this.buffered += chunk;
    let idx: number;
    while ((idx = this.buffered.indexOf('\n')) >= 0) {
      const line = this.buffered.slice(0, idx).trim();
      this.buffered = this.buffered.slice(idx + 1);
      if (line) this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Grok prints the odd non-JSON banner to stdout; ignoring it is correct,
      // and far better than killing a live turn over a cosmetic line.
      return;
    }

    const id = msg.id as number | undefined;
    const method = msg.method as string | undefined;

    if (id !== undefined && method) return this.answerAgentRequest(id, method, msg.params);
    if (id !== undefined) return this.settle(id, msg);
    if (method === 'session/update') return this.emitUpdate(msg.params);
  }

  /**
   * The agent asked US something. Anything permission-shaped gets approved;
   * anything else gets an empty result. Either way it gets an answer, because
   * silence here stalls the turn until the request timeout.
   */
  private answerAgentRequest(id: number, method: string, params: unknown): void {
    let result: unknown = {};
    if (/permission/i.test(method)) {
      const p = (params ?? {}) as { options?: AcpPermissionRequest['options'] };
      const options = p.options ?? [];
      const optionId = this.options.onPermission
        ? this.options.onPermission({ method, options })
        : pickAllowOption(options);
      result = { outcome: { outcome: 'selected', optionId } };
    }
    this.send({ jsonrpc: '2.0', id, result });
  }

  private settle(id: number, msg: Record<string, unknown>): void {
    const waiter = this.pending.get(id);
    if (!waiter) return; // already timed out, or never ours
    this.pending.delete(id);
    clearTimeout(waiter.timer);
    if (msg.error) {
      waiter.reject(new Error(`${waiter.method}: ${JSON.stringify(msg.error)}`));
    } else {
      waiter.resolve(msg.result);
    }
  }

  private emitUpdate(params: unknown): void {
    const p = (params ?? {}) as { update?: Record<string, unknown> };
    const update = p.update ?? {};
    const kind = String(update.sessionUpdate ?? '');
    if (!kind) return;
    this.options.onUpdate?.({
      kind,
      text: extractText(update),
      replay: this.replayDepth > 0,
      raw: update,
    });
  }

  private handleClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`ACP transport closed (${reason}) during ${waiter.method}`));
      this.pending.delete(id);
    }
  }
}

/**
 * Pull the human-readable text out of an update, whatever shape it arrived in.
 * Grok nests chunk text under `content.text`; other kinds carry a bare `text`
 * or a `title` (tool calls).
 */
export function extractText(update: Record<string, unknown>): string | undefined {
  const content = update.content as { text?: unknown } | undefined;
  const candidate = content?.text ?? update.text ?? update.title;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

/** Prefer an explicitly allow-shaped option; fall back to the first offered. */
export function pickAllowOption(options: AcpPermissionRequest['options']): string {
  const allow = options.find((o) => /allow/i.test(o.kind ?? o.optionId ?? o.name ?? ''));
  return allow?.optionId ?? options[0]?.optionId ?? 'allow';
}

/**
 * Build a transport over a real `grok agent stdio` child process.
 *
 * FLAG PLACEMENT IS NOT COSMETIC, and cost a round-trip to discover:
 * `--no-auto-update` is a ROOT flag and is rejected on the subcommand, while
 * `--always-approve` belongs to `agent`. Wrong order and grok exits with a
 * usage error before the handshake, which surfaces as an unexplained
 * transport-closed on initialize.
 *
 * `--always-approve` is what keeps tool use from stalling: with it the agent
 * never sends a permission request at all (measured: zero permission RPCs
 * across a real tool call), so AcpClient's auto-answer is a backstop, not the
 * mechanism.
 */
export interface GrokSpawnOptions {
  /** Path to the grok binary. Defaults to the CLI's own install location. */
  binPath?: string;
  model?: string;
  /** Extra args appended after the built-in ones. */
  extraArgs?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** Injected for tests; defaults to node:child_process spawn. */
  spawnFn?: typeof import('node:child_process').spawn;
}

export function buildGrokArgs(options: GrokSpawnOptions = {}): string[] {
  const args = ['--no-auto-update', 'agent', '--always-approve'];
  if (options.model) args.push('--model', options.model);
  args.push('stdio', ...(options.extraArgs ?? []));
  return args;
}

export async function spawnGrokTransport(options: GrokSpawnOptions = {}): Promise<AcpTransport> {
  const { spawn } = options.spawnFn ? { spawn: options.spawnFn } : await import('node:child_process');
  const bin = options.binPath ?? `${process.env.HOME ?? ''}/.grok/bin/grok`;

  const child = spawn(bin, buildGrokArgs(options), {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: options.cwd,
    env: { ...process.env, ...options.env } as NodeJS.ProcessEnv,
  });

  let closeHandler: (reason: string) => void = () => {};
  let stderrTail = '';

  child.stderr?.on('data', (d: Buffer) => {
    // Keep only the tail: it is the difference between "transport closed" and
    // "transport closed because grok rejected an argument".
    stderrTail = (stderrTail + d.toString()).slice(-2000);
  });
  child.on('exit', (code, signal) => {
    const why = signal ? `signal ${signal}` : `exit code ${code}`;
    closeHandler(stderrTail.trim() ? `${why}: ${stderrTail.trim().slice(-400)}` : why);
  });
  child.on('error', (err: Error) => closeHandler(`spawn failed: ${err.message}`));

  return {
    write: (line) => void child.stdin?.write(line + '\n'),
    onLine: (handler) => void child.stdout?.on('data', (d: Buffer) => handler(d.toString())),
    onClose: (handler) => void (closeHandler = handler),
    close: () => {
      if (!child.killed) child.kill();
    },
  };
}
