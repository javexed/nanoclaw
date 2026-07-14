export interface AgentProvider {
  /**
   * True if the provider's underlying SDK handles slash commands natively and
   * wants them passed through as raw text. When false, the poll-loop formats
   * slash commands like any other chat message.
   */
  readonly supportsNativeSlashCommands: boolean;

  /**
   * Optional. True when the provider can run a QueryInput.learningReview query
   * with the toolset actually restricted and the session forked. Advertising
   * this without enforcing it would silently hand a "restricted" review the
   * full toolset — so only set it where both halves are real.
   */
  readonly supportsRestrictedReview?: boolean;

  /**
   * Optional. When true, the runner scaffolds a persistent `memory/` tree in the
   * agent's workspace at boot. Providers with their own native memory (e.g.
   * Claude's `CLAUDE.local.md`) omit this and get nothing — memory is opt-in per
   * provider, never gated on a provider name.
   */
  readonly usesMemoryScaffold?: boolean;

  /**
   * Optional. Called by the poll-loop after each completed exchange (a
   * result, a wrapping retry, or an error). Providers whose harness keeps no
   * on-disk transcript implement this to persist exchanges themselves (e.g.
   * markdown into the agent's `conversations/` dir); providers that persist
   * and archive their own transcript (e.g. the Claude Agent SDK's `.jsonl`)
   * omit it. Best-effort: the loop catches and logs anything it throws. The
   * implementation lives with the provider, never in the runner.
   */
  onExchangeComplete?(exchange: ProviderExchange): void;

  /** Start a new query. Returns a handle for streaming input and output. */
  query(input: QueryInput): AgentQuery;

  /**
   * True if the given error indicates the stored continuation is invalid
   * (missing transcript, unknown session, etc.) and should be cleared.
   */
  isSessionInvalid(err: unknown): boolean;

  /**
   * Optional pre-resume maintenance. Given the stored continuation token,
   * decide whether its backing transcript has grown too large or too old to
   * resume cheaply. Return a non-null reason string to tell the caller to drop
   * the continuation and start a fresh session (the provider archives any
   * recoverable summary first); return null to keep resuming.
   *
   * Guards the cold-resume failure mode: a long-lived hub session accumulates
   * days of history — including base64 image blocks the agent Read — and the
   * SDK reloads the whole .jsonl on every resume. Past a threshold the first
   * turn alone can exceed the host's idle ceiling, so the container is killed
   * before it ever replies. Providers without an on-disk transcript omit this.
   */
  maybeRotateContinuation?(continuation: string, cwd: string): string | null;
}

/** One prompt/result round-trip, as reported to `onExchangeComplete`. */
export interface ProviderExchange {
  /** The user prompt this exchange answers (never an internal retry nudge). */
  prompt: string;
  result: string | null;
  /** Continuation/thread id in effect for the exchange, if any. */
  continuation?: string;
  status: 'completed' | 'undelivered' | 'error';
}

/**
 * Options passed to provider constructors. Fields are common to most
 * providers; individual providers may ignore any they don't need.
 */
export interface ProviderOptions {
  /**
   * Which Claude settings scopes the provider loads (SDK settingSources).
   * Default: all of project/user/local. An escalation fallback passes a list
   * WITHOUT 'user' so the group's settings.json env (e.g. a local-router
   * ANTHROPIC_BASE_URL, which beats process env) cannot capture its query.
   */
  settingSources?: Array<'project' | 'user' | 'local'>;
  assistantName?: string;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string | undefined>;
  additionalDirectories?: string[];
  /**
   * Model alias (`sonnet`, `opus`, `haiku`) or full model ID. Passed through
   * to the underlying SDK. If omitted, the SDK default is used.
   */
  model?: string;
  /**
   * Reasoning effort (`'low' | 'medium' | 'high' | 'xhigh' | 'max'`). Passed
   * through to the underlying SDK. If omitted, the SDK default is used.
   */
  effort?: string;
}

export interface QueryInput {
  /** Initial prompt (already formatted by agent-runner). */
  prompt: string;

  /**
   * Opaque continuation token from a previous query. The provider decides
   * what this means (session ID, thread ID, nothing at all).
   */
  continuation?: string;

  /** Working directory inside the container. */
  cwd: string;

  /**
   * System context to inject. Providers translate this into whatever their
   * SDK expects (preset append, full system prompt, per-turn injection…).
   */
  systemContext?: {
    instructions?: string;
  };

  /**
   * Run this query as a LEARNING REVIEW (docs/design/learning-loop.md §2): the
   * session's transcript in context, but a toolset restricted to draft_skill
   * alone — no destinations, no a2a, no self-mod, no shell — and a session FORK,
   * so nothing the review does disturbs the main conversation. Providers that
   * can't honor the restriction must not advertise supportsRestrictedReview;
   * the runner then falls back to an ordinary in-turn review.
   */
  learningReview?: boolean;
}

/**
 * An MCP server wired into an agent. Two transports:
 *  - stdio (default): a subprocess spawned inside the container.
 *  - remote (sse | http): a server reached over the network by URL — e.g. a
 *    tool server running on another machine. Both are passed straight to the
 *    Agent SDK's `mcpServers`, which accepts the same union.
 */
export type McpServerConfig = McpStdioServerConfig | McpRemoteServerConfig;

export interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Tool allowlist for this server — absent means every tool it exposes. */
  enabledTools?: string[];
}

export interface McpRemoteServerConfig {
  type: 'sse' | 'http';
  url: string;
  headers?: Record<string, string>;
  /** Tool allowlist for this server — absent means every tool it exposes. */
  enabledTools?: string[];
}

export interface AgentQuery {
  /** Push a follow-up message into the active query. */
  push(message: string): void;

  /** Signal that no more input will be sent. */
  end(): void;

  /** Output event stream. */
  events: AsyncIterable<ProviderEvent>;

  /** Force-stop the query. */
  abort(): void;
}

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  /**
   * A completed turn. `isError` is set when the underlying SDK flagged the
   * turn as an error (e.g. a non-retryable Anthropic 403 billing_error). The
   * poll-loop uses it to surface the result text to the user instead of
   * dropping it as un-wrapped scratchpad, and to skip the re-wrap nudge.
   */
  | { type: 'result'; text: string | null; isError?: boolean }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string }
  /**
   * A line of the agent's reasoning/thinking, surfaced to rich clients (the
   * webchat thinking-bubble fading feed). Cosmetic; providers without thinking
   * output simply never yield it.
   */
  | { type: 'reasoning'; message: string }
  /**
   * Liveness signal. Providers MUST yield this on every underlying SDK
   * event (tool call, thinking, partial message, anything) so the
   * poll-loop's idle timer stays honest during long tool runs.
   */
  | { type: 'activity' }
  /**
   * A file the provider produced this turn (e.g. a codex-generated image).
   * Carried so provider code that emits it type-checks. NOTE: the poll-loop
   * does not yet deliver these as attachments — neither does upstream — so a
   * `file` event is currently ignored at runtime. Wiring delivery (write to the
   * batch's reply destination) is a separate future enhancement.
   */
  | { type: 'file'; path: string };
