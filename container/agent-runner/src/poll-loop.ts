import { findByName, findByRouting, getAllDestinations, type DestinationEntry } from './destinations.js';
import {
  getPendingMessages,
  markProcessing,
  markCompleted,
  markScriptSkipped,
  type MessageInRow,
} from './db/messages-in.js';
import { writeMessageOut, getMaxOutboundSeq } from './db/messages-out.js';
import {
  getInboundDb,
  touchHeartbeat,
  clearStaleProcessingAcks,
  appendStatusEvent,
  getTurnToolCount,
  clearStatusEvents,
} from './db/connection.js';
import {
  clearContinuation,
  clearCurrentInReplyTo,
  migrateLegacyContinuation,
  setContinuation,
  setCurrentInReplyTo,
} from './db/session-state.js';
import {
  formatMessages,
  extractRouting,
  categorizeMessage,
  isClearCommand,
  isLearnCommand,
  isRunnerCommand,
  stripInternalTags,
  type RoutingContext,
  redactSecrets,
} from './formatter.js';
import { isUploadTraceCommand, uploadTrace } from './upload-trace.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderExchange } from './providers/types.js';
import { LEARNING_REVIEW_PROMPT } from './mcp-tools/draft-skill.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;

/**
 * Number of consecutive `database disk image is malformed` errors after which
 * the follow-up poll gives up and exits the process. At ACTIVE_POLL_INTERVAL_MS
 * = 500ms this is roughly 5 seconds — long enough to dodge a transient torn
 * read during a host write, short enough to recover quickly from a poisoned
 * page cache (host-sweep then respawns with a fresh mount).
 */
const CORRUPTION_STREAK_EXIT = 10;

/**
 * True for SQLite errors that indicate a corrupt READ view — almost always a
 * cross-mount page-cache coherency issue on Docker Desktop macOS rather than
 * actual file damage (host-side integrity_check passes). Reopening the DB
 * handle inside this process does NOT recover; only a fresh container mount
 * does. Caller's job is to exit so host-sweep respawns the container.
 */
export function isCorruptionError(msg: string): boolean {
  return (
    msg.includes('database disk image is malformed') ||
    msg.includes('SQLITE_CORRUPT') ||
    msg.includes('file is not a database')
  );
}

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface PollLoopConfig {
  provider: AgentProvider;
  /**
   * Name of the provider (e.g. "claude", "codex"). Used to key
   * the stored continuation per-provider so flipping providers doesn't
   * resurrect a stale id from a different backend.
   */
  providerName: string;
  cwd: string;
  systemContext?: {
    instructions?: string;
  };
  /** Learning-loop behavior from container.json (see docs/learning-loop.md). */
  learning?: {
    autoTrigger?: boolean;
    autoKeep?: boolean;
    cooldownMinutes?: number;
    rooms?: Record<string, { autoTrigger?: boolean; autoKeep?: boolean }>;
    /** Classifier gate — {url, model}: consulted before an auto-review. */
    classifier?: { url: string; model: string };
  };
  /**
   * Optional stop signal. In production the loop runs until the container
   * dies; tests pass a signal so an abandoned loop actually exits instead of
   * polling forever and stealing messages from the next test's DB.
   */
  signal?: AbortSignal;
  /**
   * Deliver unwrapped prose to the originating room instead of dropping it.
   * Set for ollama-backed agents (see RunnerConfig.lenientOutput).
   */
  lenientOutput?: boolean;
}


/**
 * Main poll loop. Runs indefinitely until the process is killed.
 *
 * 1. Poll messages_in for pending rows
 * 2. Format into prompt, call provider.query()
 * 3. While query active: continue polling, push new messages via provider.push()
 * 4. On result: write messages_out
 * 5. Mark messages completed
 * 6. Loop
 */
export async function runPollLoop(config: PollLoopConfig): Promise<void> {
  // Auto-trigger state (learning loop). Container-scoped on purpose: a
  // container that idles out and respawns starts a fresh window, which at worst
  // means one extra review per respawn — bounded, and stateless.
  let lastAutoReviewAt: number | null = null;
  let autoReviewInFlight = false;
  // Resume the agent's prior session from a previous container run if one
  // was persisted. The continuation is opaque to the poll-loop — the
  // provider decides how to use it (Claude resumes a .jsonl transcript,
  // other providers may reload a thread ID, etc.). Keyed per-provider so
  // a Codex thread id never gets handed to Claude or vice versa.
  let continuation: string | undefined = migrateLegacyContinuation(config.providerName);

  // Before resuming, drop a session whose on-disk transcript has grown too
  // large/old to cold-resume within the host's idle ceiling. Without this a
  // long-lived hub keeps trying to reload an ever-growing .jsonl, hangs the
  // first turn, and gets killed before it can reply (then repeats forever).
  if (continuation) {
    const rotateReason = config.provider.maybeRotateContinuation?.(continuation, config.cwd);
    if (rotateReason) {
      log(`Rotating session — ${rotateReason}; starting fresh`);
      clearContinuation(config.providerName);
      continuation = undefined;
    }
  }

  if (continuation) {
    log(`Resuming agent session ${continuation}`);
  }

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  clearStaleProcessingAcks();

  let pollCount = 0;
  let isFirstPoll = true;
  while (true) {
    if (config.signal?.aborted) return;
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question)
    const rawPending = getPendingMessages(isFirstPoll).filter((m) => m.kind !== 'system');
    // Interrupt rows are control signals delivered by the host (GUI/CLI "stop").
    // Mid-turn they're caught by the active-stream poll below and abort the
    // query; one that lands here (between turns / no live stream) has nothing to
    // stop — consume it so it never starts a turn of its own.
    const staleInterrupts = rawPending.filter((m) => m.kind === 'interrupt');
    if (staleInterrupts.length > 0) markCompleted(staleInterrupts.map((m) => m.id));
    const messages = rawPending.filter((m) => m.kind !== 'interrupt');
    isFirstPoll = false;
    pollCount++;

    // Periodic heartbeat so we know the loop is alive
    if (pollCount % 30 === 0) {
      log(`Poll heartbeat (${pollCount} iterations, ${messages.length} pending)`);
    }

    if (messages.length === 0) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Accumulate gate: if the batch contains only trigger=0 rows
    // (context-only, router-stored under ignored_message_policy='accumulate'),
    // don't wake the agent. Leave them `pending` — they'll ride along the
    // next time a real trigger=1 message lands via this same getPendingMessages
    // query. Without this gate, a warm container keeps processing
    // (and potentially responding to) every accumulate-only batch, defeating
    // the "store as context, don't engage" contract. Host-side countDueMessages
    // gates the same way for wake-from-cold (see src/db/session-db.ts).
    if (!messages.some((m) => m.trigger === 1)) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const ids = messages.map((m) => m.id);
    markProcessing(ids);

    // Reset the webchat activity feed so the thinking bubble shows only this
    // turn's tool/progress/reasoning events (cosmetic; see connection.ts).
    clearStatusEvents();

    const routing = extractRouting(messages);

    // Command handling: the host router gates filtered and unauthorized
    // admin commands before they reach the container. The only command
    // the runner handles directly is /clear (session reset).
    const normalMessages: MessageInRow[] = [];
    const commandIds: string[] = [];
    let learnReviewRequested = false;
    let learnReviewPrompt = LEARNING_REVIEW_PROMPT;

    for (const msg of messages) {
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isClearCommand(msg)) {
        log('Clearing session (resetting continuation)');
        continuation = undefined;
        clearContinuation(config.providerName);
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: 'Session cleared.' }),
        });
        commandIds.push(msg.id);
        continue;
      }
      // `/learn` — the learning loop's explicit trigger. Where the provider can,
      // the review runs ISOLATED (design §2): a fork of this session with
      // draft_skill as its only tool — the transcript is in context, but the
      // review can neither touch the conversation nor reach any other tool.
      // Providers that can't restrict fall back to an ordinary turn whose prompt
      // is the authoring instruction — same review, full toolset, main session.
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isLearnCommand(msg)) {
        // Anything after `/learn` is the user steering the review ("/learn the
        // rsync part", "/learn keep it even though it's well-known") — replacing
        // it wholesale with the authoring prompt would throw their words away.
        const parsed = JSON.parse(msg.content) as Record<string, unknown>;
        const hint = String(parsed.text || '').replace(/^\s*\/learn\b/i, '').trim();
        const reviewPrompt = hint
          ? `${LEARNING_REVIEW_PROMPT}\n\nThe user added, when asking for this review: "${hint}". Treat that as direct guidance about what to keep — the user overrides the "well-known" bar, but never the denylist or the no-invention rule.`
          : LEARNING_REVIEW_PROMPT;
        if (config.provider.supportsRestrictedReview) {
          log('Learning review requested (/learn) — isolated restricted pass');
          learnReviewRequested = true;
          learnReviewPrompt = reviewPrompt;
          commandIds.push(msg.id);
        } else {
          log('Learning review requested (/learn) — inline fallback (provider cannot restrict)');
          normalMessages.push({
            ...msg,
            content: JSON.stringify({ ...parsed, text: reviewPrompt }),
          });
        }
        continue;
      }
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isUploadTraceCommand(msg)) {
        log('Uploading session trace to Hugging Face');
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: uploadTrace() }),
        });
        commandIds.push(msg.id);
        continue;
      }
      normalMessages.push(msg);
    }

    if (commandIds.length > 0) {
      markCompleted(commandIds);
    }

    // Isolated learning review (design §2), run to completion at the idle point.
    // Must sit BEFORE the empty-batch early-exit below: /learn usually arrives
    // alone, which makes normalMessages empty — exactly the batch shape that
    // early-exit skips. The review resumes this session as a FORK, so nothing
    // it does touches the conversation the next real turn resumes.
    if (learnReviewRequested) {
      await runLearningReview(config, routing, messages, continuation, learnReviewPrompt);
    }

    if (normalMessages.length === 0) {
      const remainingIds = ids.filter((id) => !commandIds.includes(id));
      if (remainingIds.length > 0) markCompleted(remainingIds);
      log(`All ${messages.length} message(s) were commands, skipping query`);
      continue;
    }

    // Pre-task scripts: for any task rows with a `script`, run it before the
    // provider call. Scripts returning wakeAgent=false (or erroring) gate
    // their own task row only — surviving messages still go to the agent.
    // Without the scheduling module, the marker block is empty, `keep`
    // falls back to `normalMessages`, and no gating happens.
    let keep: MessageInRow[] = normalMessages;
    let skipped: Array<{ id: string; reason: string }> = [];
    // MODULE-HOOK:scheduling-pre-task:start
    const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
    const preTask = await applyPreTaskScripts(normalMessages);
    keep = preTask.keep;
    skipped = preTask.skipped;
    if (skipped.length > 0) {
      markScriptSkipped(skipped);
      log(`Pre-task script skipped ${skipped.length} task(s): ${skipped.map((s) => s.id).join(', ')}`);
    }
    // MODULE-HOOK:scheduling-pre-task:end

    if (keep.length === 0) {
      log(`All ${normalMessages.length} non-command message(s) gated by script, skipping query`);
      continue;
    }

    // Format messages: passthrough commands get raw text (only if the
    // provider natively handles slash commands), others get XML.
    const prompt = formatMessagesWithCommands(keep, config.provider.supportsNativeSlashCommands);

    log(`Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}`);

    // Mark the turn as started so the webchat bubble appears immediately and
    // persists for the whole turn, independent of the heartbeat-driven typing
    // signal. A real query is guaranteed to run from here, so the matching
    // 'done' (after markCompleted below) always pairs with this 'start'.
    appendStatusEvent('start', null);

    // Process the query while concurrently polling for new messages
    const skippedSet = new Set(skipped.map((s) => s.id));
    const processingIds = ids.filter((id) => !commandIds.includes(id) && !skippedSet.has(id));
    // Publish the batch's in_reply_to so MCP tools (send_message, send_file)
    // can stamp it on outbound rows — needed for a2a return-path routing.
    setCurrentInReplyTo(routing.inReplyTo);
    // Rooms this batch came from — a reply defaults back here (origin guard in
    // dispatchResultText pins a misaddressed lone reply to the originating room).
    const originDests = resolveOriginDestinations(messages);
    // Per-turn auto-trigger (docs/learning-loop.md §1). Invoked from INSIDE the
    // open query at each result — hub sessions hold the query for hours, so a
    // post-query hook would never fire. Fire-and-forget with an in-flight
    // guard: the event drain never stalls, and reviews never stack.
    const maybeAutoReview = (toolCount: number): void => {
      if (autoReviewInFlight) return;
      if (
        !shouldAutoReview({
          learning: resolveRoomLearning(config.learning, routing),
          supportsRestrictedReview: config.provider.supportsRestrictedReview === true,
          toolCount,
          hadLearnCommand: learnReviewRequested,
          lastAutoReviewAt,
          now: Date.now(),
        })
      )
        return;
      autoReviewInFlight = true;
      lastAutoReviewAt = Date.now();
      const clf = config.learning?.classifier;
      void (async () => {
        try {
          if (clf?.url && clf?.model && !(await classifyWorthReviewing(clf, messages, toolCount))) {
            log(`Learning classifier: turn not skill-worthy — skipping review`);
            return;
          }
          log(`Auto learning review (turn used ${toolCount} tools)`);
          await runLearningReview(config, routing, messages, continuation, LEARNING_REVIEW_PROMPT, {
            announceDecline: false,
          });
        } catch (err) {
          log(`Auto learning review failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          autoReviewInFlight = false;
        }
      })();
    };

    const query = config.provider.query({
      prompt,
      continuation,
      cwd: config.cwd,
      systemContext: config.systemContext,
    });
    try {
      let result = await processQuery(
        query,
        routing,
        processingIds,
        config.providerName,
        config.provider.onExchangeComplete?.bind(config.provider),
        prompt,
        continuation,
        originDests,
        config.lenientOutput ?? false,
        config.signal,
        maybeAutoReview,
      );

      // Shutdown, not turn failure: the stop signal aborted the query
      // mid-turn. No error message and no empty-turn net — the host (or
      // test) tearing us down owns the messaging from here.
      if (config.signal?.aborted) return;

      // Self-heal a dead/stale continuation. Unlike a thrown error (recovered
      // in the catch block below), an unusable resume id surfaces as a
      // terminal-error RESULT ("No conversation found …") and would otherwise be
      // shown to the user every turn forever. Clear the continuation and retry
      // the turn ONCE with a fresh session, so a single dead conversation fails
      // silently-and-recovers instead of erroring this turn (or every turn after).
      if (result.terminalError && continuation && config.provider.isSessionInvalid(result.terminalError.message)) {
        log(`Dead continuation in terminal error (${continuation}) — clearing and retrying fresh`);
        continuation = undefined;
        clearContinuation(config.providerName);
        result = await processQuery(
          config.provider.query({
            prompt,
            continuation: undefined,
            cwd: config.cwd,
            systemContext: config.systemContext,
          }),
          routing,
          processingIds,
          config.providerName,
          config.provider.onExchangeComplete?.bind(config.provider),
          prompt,
          undefined,
          originDests,
          config.lenientOutput ?? false,
          config.signal,
          maybeAutoReview,
        );
      }

      if (result.continuation && result.continuation !== continuation) {
        continuation = result.continuation;
        setContinuation(config.providerName, continuation);
      }

      // (A) Non-quota terminal error (model not found, backend unreachable, an
      // error result, or the SDK dying mid-stream): surface it to the user
      // instead of dropping the turn. The quota case writes its own message
      // inline, so it never reaches here.
      if (result.terminalError) {
        surfaceTerminalError(routing, result.terminalError);
        result.producedOutput = true;
      }

      // (B) Empty-turn safety net. Neither result text nor an MCP send nor an
      // error message went out, and no terminal error was surfaced — true
      // silence, almost always a model/config problem the user must be told
      // about rather than left staring at nothing.
      if (!result.producedOutput && !result.terminalError) {
        log('Turn produced no output and no error — writing empty-turn fallback');
        writeUserText(
          routing,
          "I wasn't able to produce a response — this usually means a model or " +
            'configuration problem; an admin may need to check this agent.',
        );
      }

        // Auto-trigger (docs/learning-loop.md §1): a busy turn just finished —
        // run the isolated review WITHOUT waiting for a human tap. Decline stays
        // silent; only a real draft announces itself (the in-room card). Errors
        // never disturb the turn that already completed.
    } catch (err) {
      // Same shutdown guard as the result path — an abort-induced throw is
      // teardown, not a provider failure to report.
      if (config.signal?.aborted) return;
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Query error: ${errMsg}`);

      // Stale/corrupt continuation recovery: ask the provider whether
      // this error means the stored continuation is unusable, and clear
      // it so the next attempt starts fresh.
      if (continuation && config.provider.isSessionInvalid(err)) {
        log(`Stale session detected (${continuation}) — clearing for next retry`);
        continuation = undefined;
        clearContinuation(config.providerName);
      }

      // Write error response so the user knows something went wrong
      writeUserText(routing, `Error: ${redactSecrets(errMsg)}`);

      // The batch is still acked completed below (no redelivery). Without
      // this line the only log trace of the errored turn is "Query error"
      // followed by a "Completed" line that reads like success.
      log(`Errored batch will be acked completed — ${processingIds.length} message(s), no redelivery`);
    } finally {
      clearCurrentInReplyTo();
    }

    // Ensure completed even if processQuery ended without a result event
    // (e.g. stream closed unexpectedly).
    markCompleted(processingIds);
    log(`Completed ${ids.length} message(s)`);

    // Signal the webchat thinking bubble that the turn is done so the static
    // activity line clears even when the turn produced no user-facing message.
    appendStatusEvent('done', null);
  }
}

/** Write a plain chat message to the batch's origin routing. */
function writeUserText(routing: RoutingContext, text: string): void {
  writeMessageOut({
    id: generateId(),
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text }),
  });
}

/**
 * (A) Surface a non-quota terminal error to the user. The user-facing text
 * stays generic for `config` (the raw model error is rarely actionable for
 * them) but includes the detail otherwise.
 */
function surfaceTerminalError(routing: RoutingContext, err: TerminalError | undefined): void {
  if (!err) return;
  // Provider errors can echo request headers/URLs — redact credential shapes
  // before anything reaches a chat room (security model §redaction).
  err = { ...err, message: redactSecrets(err.message) };
  const text =
    err.classification === 'config'
      ? `I couldn't reach the configured model (${err.message}). An admin may need to check this agent's model setting.`
      : err.classification === 'network'
        ? `I couldn't reach the model backend (${err.message}). An admin may need to check the connection.`
        : `Something went wrong: ${err.message}`;
  writeUserText(routing, text);
}

/**
 * Format messages, handling passthrough commands differently.
 * When the provider handles slash commands natively (Claude Code),
 * passthrough commands are sent raw (no XML wrapping) so the SDK can
 * dispatch them. Otherwise they fall through to standard XML formatting.
 */
function formatMessagesWithCommands(messages: MessageInRow[], nativeSlashCommands: boolean): string {
  const parts: string[] = [];
  const normalBatch: MessageInRow[] = [];

  for (const msg of messages) {
    if (nativeSlashCommands && (msg.kind === 'chat' || msg.kind === 'chat-sdk')) {
      const cmdInfo = categorizeMessage(msg);
      if (cmdInfo.category === 'passthrough' || cmdInfo.category === 'admin') {
        // Flush normal batch first
        if (normalBatch.length > 0) {
          parts.push(formatMessages(normalBatch));
          normalBatch.length = 0;
        }
        // Pass raw command text (no XML wrapping) — SDK handles it natively
        parts.push(cmdInfo.text);
        continue;
      }
    }
    normalBatch.push(msg);
  }

  if (normalBatch.length > 0) {
    parts.push(formatMessages(normalBatch));
  }

  return parts.join('\n\n');
}

interface TerminalError {
  message: string;
  classification?: string;
}

interface QueryResult {
  continuation?: string;
  /**
   * Set when the turn ended on a non-retryable, NON-quota provider error (the
   * quota case is handled inline — it writes its own user-facing message). The
   * outer loop surfaces this to the user (A).
   */
  terminalError?: TerminalError;
  /**
   * True if the turn wrote anything outbound (an MCP send, dispatched result
   * text, or an inline error message). Measured via an outbound-seq delta, so
   * it's robust to MCP sends the poll-loop never sees. A turn that produced no
   * output AND no terminalError is true silence → empty-turn safety net (B).
   */
  producedOutput: boolean;
}

export async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
  onExchangeComplete: ((exchange: ProviderExchange) => void) | undefined,
  initialPrompt: string,
  initialContinuation: string | undefined,
  originDests: DestinationEntry[] = [],
  lenient = false,
  signal?: AbortSignal,
  /**
   * Fires when a TURN completes (each result event) with that turn's tool
   * count. Hub-style sessions hold the query open for hours, so anything that
   * must react per-turn — the learning auto-trigger — hooks here rather than
   * after processQuery returns. Fired without await: the event drain must
   * never stall behind it.
   */
  onTurnComplete?: (toolCount: number) => void,
): Promise<QueryResult> {
  let queryContinuation: string | undefined;
  let done = false;
  let unwrappedNudged = false;
  // Once-per-turn guard for the task-run "<message> block was not delivered"
  // nudge — mirrors unwrappedNudged for chat turns.
  let taskBlockNudged = false;
  // Prompt queue for the exchange hook — each result event consumes the
  // oldest unanswered prompt, except a wrapping-retry result, which answers
  // the same prompt again. Unused (and unmaintained) when the provider
  // doesn't implement `onExchangeComplete`.
  const archivePrompts: string[] = [initialPrompt];

  // Capture the outbound high-water mark before the turn. Any write during the
  // turn (MCP send, dispatched result text, inline error message) advances it;
  // the delta after the turn tells us whether the agent produced ANY output.
  // This is the empty-turn detector: a zero delta with no terminalError is
  // true silence. See db/messages-out.ts getMaxOutboundSeq().
  const outboundSeqBefore = getMaxOutboundSeq();

  let terminalError: TerminalError | undefined;

  // Concurrent polling: push follow-ups into the active query as they arrive.
  // We do NOT force-end the stream on silence — keeping the query open avoids
  // re-spawning the SDK subprocess (~few seconds) and re-loading the .jsonl
  // transcript on every turn. The Anthropic prompt cache is server-side with
  // a 5-min TTL keyed on prefix hash, so stream lifecycle does NOT affect
  // cache lifetime — close+reopen within 5 min still gets cache hits.
  // Stream liveness is decided host-side via the heartbeat file + processing
  // claim age (see src/host-sweep.ts); if something is truly stuck, the host
  // will kill the container and messages get reset to pending.
  let pollInFlight = false;
  let endedForCommand = false;
  let corruptionStreak = 0;
  const pollHandle = setInterval(() => {
    // Abandoned-loop guard: when the surrounding runPollLoop's stop signal
    // fires while a hub-style query is still open, this interval would keep
    // polling — and STEAL pending messages meant for whoever owns the DB now
    // (in production nobody; in tests, the next test). Kill the query so the
    // stream closes and this processQuery unwinds.
    if (signal?.aborted) {
      endedForCommand = true;
      query.abort();
      return;
    }
    if (done || pollInFlight || endedForCommand) return;
    pollInFlight = true;

    void (async () => {
      try {
        const pending = getPendingMessages();

        // Interrupt: a host-delivered "stop" signal (GUI Stop button / CLI ESC).
        // Abort the active stream and mark this turn done — interrupt means
        // "stop", never "respond", so unlike a slash command we DON'T leave rows
        // pending for the outer loop: consume the interrupt row(s) and the
        // triggering batch, then emit a clean 'done' so the host clears the
        // thinking bubble (a stream that ends with no 'done' is read as a
        // mid-turn death and warns the room — see src/modules/agent-status).
        const interruptIds = pending.filter((m) => m.kind === 'interrupt').map((m) => m.id);
        if (interruptIds.length > 0) {
          log('Interrupt received — aborting active stream');
          markCompleted(interruptIds);
          markCompleted(initialBatchIds);
          appendStatusEvent('done', null);
          endedForCommand = true; // stop the poll from re-entering while we abort
          query.abort();
          return;
        }

        // Slash commands need a fresh query: /clear resets the SDK's
        // resume id (fixed at sdkQuery() time); admin/passthrough commands
        // (/compact, /cost, …) only dispatch when they're the first input
        // of a query — pushed mid-stream they arrive as plain text and
        // the SDK never runs them. Abort the active stream and leave the
        // rows pending; the outer loop handles them on next iteration via
        // the canonical command path + formatMessagesWithCommands. Abort,
        // not end: end() lets an in-flight turn run to completion, which
        // can block the command (e.g. /clear during a long task) for as
        // long as the turn takes.
        if (pending.some((m) => isRunnerCommand(m))) {
          log('Pending slash command — aborting active stream so outer loop can process');
          endedForCommand = true;
          query.abort();
          return;
        }

        // Skip system messages (MCP tool responses).
        // Thread routing is the router's concern — if a message landed in this
        // session, the agent should see it. Per-thread sessions already isolate
        // threads into separate containers; shared sessions intentionally merge
        // everything. Filtering on thread_id here caused deadlocks when the
        // initial batch and follow-ups had mismatched thread_ids (e.g. a
        // host-generated welcome trigger with null thread vs a Discord DM reply).
        const newMessages = pending.filter((m) => m.kind !== 'system');
        if (newMessages.length === 0) return;

        const newIds = newMessages.map((m) => m.id);
        markProcessing(newIds);

        // Run pre-task scripts on follow-ups too — without this, a task that
        // arrives during an active query (e.g. a */10 monitoring cron) bypasses
        // its script gate and always wakes the agent, defeating the gate.
        // Mirrors the initial-batch hook above.
        let keep = newMessages;
        let skipped: Array<{ id: string; reason: string }> = [];
        // MODULE-HOOK:scheduling-pre-task-followup:start
        const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
        const preTask = await applyPreTaskScripts(newMessages);
        keep = preTask.keep;
        skipped = preTask.skipped;
        if (skipped.length > 0) {
          markScriptSkipped(skipped);
          log(`Pre-task script skipped ${skipped.length} follow-up task(s): ${skipped.map((s) => s.id).join(', ')}`);
        }
        // MODULE-HOOK:scheduling-pre-task-followup:end

        if (keep.length === 0) return;
        // Re-check done — the outer query may have finished while the script
        // was awaited. Pushing into a closed stream is wasted work; the
        // claimed messages get released by the host's processing-claim sweep.
        if (done) return;

        const keptIds = keep.map((m) => m.id);
        const prompt = formatMessages(keep);
        log(`Pushing ${keep.length} follow-up message(s) into active query`);
        unwrappedNudged = false;
        // Webchat thinking feed: a follow-up pushed into the active query is a
        // new sub-turn for the UI. Reset the feed and re-seed 'start' so the
        // bubble reflects only this follow-up's activity — mirrors the per-turn
        // reset at the top of the outer poll loop. Without this, a busy room
        // that streams follow-ups into one long-lived query freezes the feed at
        // the first sub-turn's snapshot. Cosmetic / best-effort.
        clearStatusEvents();
        appendStatusEvent('start', null);
        taskBlockNudged = false;
        query.push(prompt);
        archivePrompts.push(prompt);
        markCompleted(keptIds);
      } catch (err) {
        // Without this catch the rejection escapes the void IIFE and Node
        // terminates the container on unhandled-rejection. The initial-batch
        // path is wrapped by processQuery's outer try/catch; the follow-up
        // path is not, so it needs its own.
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Follow-up poll error: ${errMsg}`);

        // Detect SQLite cross-mount corruption (Docker Desktop macOS virtiofs /
        // gRPC-FUSE coherency bug — the kernel page cache for the inbound.db
        // bind mount can latch a torn snapshot mid-host-write, after which
        // every fresh openInboundDb() in this process sees the same broken
        // view. Reopening inside the container does NOT recover; only a fresh
        // container mount does. Exit so the host sweep respawns us.
        if (isCorruptionError(errMsg)) {
          corruptionStreak += 1;
          if (corruptionStreak >= CORRUPTION_STREAK_EXIT) {
            log(
              `Follow-up poll: ${corruptionStreak} consecutive '${errMsg}' errors — ` +
                `inbound.db page cache is poisoned. Exiting so host respawns with a fresh mount.`,
            );
            // Stop touching the heartbeat so host-sweep stale detection fires
            // promptly even if exit() races with in-flight async work.
            done = true;
            clearInterval(pollHandle);
            // Defer exit one tick so this log line flushes through Docker's
            // log driver before the process dies.
            setTimeout(() => process.exit(75), 100);
          }
        } else {
          corruptionStreak = 0;
        }
      } finally {
        pollInFlight = false;
      }
    })();
  }, ACTIVE_POLL_INTERVAL_MS);

  try {
    for await (const event of query.events) {
      handleEvent(event, routing);
      touchHeartbeat();

      if (event.type === 'init') {
        queryContinuation = event.continuation;
        // Persist immediately so a mid-turn container crash still lets the
        // next wake resume the conversation. Without this, the session id
        // was only written after the full stream completed — if the
        // container died between `init` and `result`, the SDK session was
        // effectively orphaned and the next message started a blank
        // Claude session with no prior context.
        setContinuation(providerName, event.continuation);
      } else if (event.type === 'error' && (event.classification === 'rate_limit' || event.classification === 'quota')) {
        markCompleted(initialBatchIds);
        // A rate limit is TRANSIENT (it resets); credit exhaustion is not. Saying
        // "you may have run out of credits — check billing" for a rate limit is
        // alarming AND wrong, so the two now read differently. `event.message`
        // carries the reset/retry-after detail when the provider supplies one.
        const rateLimited = event.classification === 'rate_limit';
        const resetDetail = rateLimited ? /\((?:resets|retry after)[^)]*\)/.exec(event.message || '')?.[0] : undefined;
        const text = rateLimited
          ? `I've hit the API rate limit — it's temporary and resets on its own${resetDetail ? ` ${resetDetail}` : ''}. Send that again in a bit and I'll pick it up.`
          : "I've hit an API usage limit. You may have run out of credits on your Anthropic account — check console.anthropic.com/settings/billing.";
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text }),
        });
      } else if (event.type === 'error' && !event.retryable) {
        // A non-retryable, non-quota terminal error (model not found, backend
        // unreachable, SDK died mid-stream, an error-result subtype). Don't
        // write here — the outer loop surfaces it to the user (A). Record the
        // LAST one seen and let the stream finish draining.
        terminalError = { message: event.message, classification: event.classification };
        markCompleted(initialBatchIds);
      } else if (event.type === 'result') {
        // A result — with or without text — means the turn is done. Mark
        // the initial batch completed now so the host sweep doesn't see
        // stale 'processing' claims while the query stays open for
        // follow-up pushes. The agent may have responded via MCP
        // (send_message) mid-turn, or the message may not need a response
        // at all — either way the turn is finished.
        markCompleted(initialBatchIds);
        // Webchat thinking feed: settle the bubble for this sub-turn. Interim
        // results inside a still-open query never reach the outer-loop 'done'
        // (that fires only when the whole query ends), so without this the
        // bubble would keep showing the last activity line. Cosmetic; the
        // next follow-up re-seeds 'start'. Pairs with the reset at the push.
        appendStatusEvent('done', null);
        // Read the count NOW — a follow-up push re-seeds 'start' and zeroes it.
        if (onTurnComplete) onTurnComplete(getTurnToolCount());
        if (event.text) {
          const { sent, hasUnwrapped, taskBlocks } = dispatchResultText(event.text, routing, originDests, lenient);
          const willRetryTaskBlocks = shouldNudgeTaskBlocks(routing.taskRun, taskBlocks, taskBlockNudged);
          // One-door task delivery: the final text becomes the run log entry
          // while explicit append-log calls remain optional additive notes.
          // Errors included: a failed run's text belongs in its log, not chat.
          if (routing.taskRun && !taskBlockNudged) autoAppendTaskLog(event.text);
          if (sent === 0 && event.isError === true && !routing.taskRun) {
            // Non-retryable error turn (e.g. a 403 billing_error) with no
            // <message> envelope: deliver the notice instead of dropping it as
            // scratchpad, and skip the re-wrap nudge — it would just re-hammer
            // the failing gateway turn after turn.
            deliverErrorResult(event.text, routing);
            notifyExchangeComplete(onExchangeComplete, {
              prompt: archivePrompts[0] ?? initialPrompt,
              result: event.text,
              continuation: queryContinuation ?? initialContinuation,
              status: 'error',
            });
            archivePrompts.shift();
          } else {
            const willRetryWrapping = hasUnwrapped && !unwrappedNudged;
            notifyExchangeComplete(onExchangeComplete, {
              prompt: archivePrompts[0] ?? initialPrompt,
              result: event.text,
              continuation: queryContinuation ?? initialContinuation,
              status: hasUnwrapped || willRetryTaskBlocks ? 'undelivered' : 'completed',
            });
            if (willRetryWrapping) {
              unwrappedNudged = true;
              const destinations = getAllDestinations();
              const names = destinations.map((d) => d.name).join(', ');
              query.push(
                `<system>Your response was not delivered — it was not wrapped in <message to="name">...</message> blocks. ` +
                  `All output must be wrapped: use <message to="name"> for content to send, or <internal> for scratchpad. ` +
                  `Your destinations: ${names}. ` +
                  `Please re-send your response with the correct wrapping.</system>`,
              );
            }
            if (willRetryTaskBlocks) {
              taskBlockNudged = true;
              const names = getAllDestinations()
                .map((d) => d.name)
                .join(', ');
              query.push(buildTaskBlockNudge(taskBlocks, names));
            }
            // A retry result (wrapping or task-block nudge) answers the SAME
            // user prompt — keep it queued so the retry archives against it,
            // not the nudge text.
            if (!willRetryWrapping && !willRetryTaskBlocks) archivePrompts.shift();
          }
        } else archivePrompts.shift();
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    notifyExchangeComplete(onExchangeComplete, {
      prompt: archivePrompts[0] ?? initialPrompt,
      result: `Error: ${errMsg}`,
      continuation: queryContinuation ?? initialContinuation,
      status: 'error',
    });
    throw err;
  } finally {
    done = true;
    clearInterval(pollHandle);
  }

  // Did the turn write anything outbound? Compare the high-water mark now vs.
  // before. A non-quota terminalError wrote nothing here (deferred to the outer
  // loop), so a delta of zero with a terminalError is expected; a delta of zero
  // with NO terminalError is true silence.
  const producedOutput = getMaxOutboundSeq() > outboundSeqBefore;

  return { continuation: queryContinuation, terminalError, producedOutput };
}

function notifyExchangeComplete(
  hook: ((exchange: ProviderExchange) => void) | undefined,
  exchange: ProviderExchange,
): void {
  if (!hook) return;
  try {
    hook(exchange);
  } catch (err) {
    log(`onExchangeComplete failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function handleEvent(event: ProviderEvent, _routing: RoutingContext): void {
  switch (event.type) {
    case 'init':
      log(`Session: ${event.continuation}`);
      break;
    case 'result':
      log(`Result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      break;
    case 'error':
      log(
        `Error: ${event.message} (retryable: ${event.retryable}${event.classification ? `, ${event.classification}` : ''})`,
      );
      break;
    case 'progress':
      log(`Progress: ${event.message}`);
      // Surface milestones to the webchat thinking bubble (cosmetic).
      appendStatusEvent('progress', event.message);
      break;
    case 'reasoning':
      // Agent reasoning line → webchat thinking-bubble fading feed (cosmetic).
      appendStatusEvent('reasoning', event.message);
      break;
  }
}

/**
 * Deliver a turn's text straight to the channel the batch arrived on. Used when
 * a turn ends in a provider error (e.g. a non-retryable 403 billing_error) with
 * no <message> envelope: the notice would otherwise be dropped as scratchpad.
 * This is the same user-facing write the outer catch block does, minus the
 * `Error:` prefix — the provider's text is already a user-facing message.
 */
/**
 * The isolated learning review (docs/design/learning-loop.md §2).
 *
 * A second provider query at the idle point, on a FORK of the session: the whole
 * transcript is in context (no cold start, nothing re-read), but the toolset is
 * draft_skill alone and the fork's continuation is deliberately discarded — the
 * review can propose a skill and say one sentence, and can do nothing else to
 * anything. This is Hermes' spawn_background_review, expressed as provider
 * options instead of their _persist_disabled/_session_db=None flags.
 */
/**
 * The auto-trigger decision (docs/learning-loop.md §1), pure.
 *
 * Auto-trigger is ON unless explicitly disabled — it only ever STAGES a draft,
 * so the human gate survives at Keep. The guards are about cost and noise:
 *   - the turn must have been busy (Hermes' bare heuristic: ≥5 tool calls);
 *   - a per-container cooldown (default 30 min) bounds spend on chatty rooms;
 *   - a turn that was itself a /learn never re-triggers (the review is done);
 *   - the provider must support the RESTRICTED pass — auto mode never falls
 *     back to the full-toolset in-turn review, because nobody is watching it.
 */
export const AUTO_REVIEW_MIN_TOOLS = 5;
/**
 * Room override wins over the agent level: the rooms map is keyed by the
 * "<channel_type>:<platform_id>" pair the batch's routing context carries.
 * A room with no entry inherits the agent-level settings untouched.
 */
export function resolveRoomLearning(
  learning: PollLoopConfig['learning'],
  routing: { channelType: string | null; platformId: string | null },
): PollLoopConfig['learning'] {
  const room =
    routing.channelType && routing.platformId
      ? learning?.rooms?.[`${routing.channelType}:${routing.platformId}`]
      : undefined;
  return room ? { ...learning, ...room } : learning;
}

export function shouldAutoReview(args: {
  learning: PollLoopConfig['learning'];
  supportsRestrictedReview: boolean;
  toolCount: number;
  hadLearnCommand: boolean;
  lastAutoReviewAt: number | null;
  now: number;
}): boolean {
  const { learning, supportsRestrictedReview, toolCount, hadLearnCommand, lastAutoReviewAt, now } = args;
  if (learning?.autoTrigger === false) return false;
  if (!supportsRestrictedReview) return false;
  if (hadLearnCommand) return false;
  if (toolCount < AUTO_REVIEW_MIN_TOOLS) return false;
  const cooldownMs = (learning?.cooldownMinutes ?? 30) * 60_000;
  if (lastAutoReviewAt !== null && now - lastAutoReviewAt < cooldownMs) return false;
  return true;
}

/**
 * Classifier gate: ask a small local model whether a busy turn is actually
 * worth distilling into a skill, before spending the (expensive) review on the
 * agent's own model. Best-effort — any failure (unreachable, timeout, bad
 * response) returns true so a classifier hiccup never SILENTLY drops a review
 * the heuristic already flagged. The endpoint is container-reachable (resolved
 * host-side at pick time).
 */
export async function classifyWorthReviewing(
  classifier: { url: string; model: string },
  messages: MessageInRow[],
  toolCount: number,
): Promise<boolean> {
  const asks = messages
    .map((m) => (m.content || '').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 2000);
  const system =
    'You gate a skill-learning loop. Given what a user asked and how much tool ' +
    'work an assistant did, decide if this turn performed a REUSABLE procedure ' +
    'worth saving as a skill (a repeatable workflow, a non-obvious setup, a ' +
    'multi-step task likely to recur). One-off chit-chat, simple lookups, or ' +
    'unique/personal requests are NOT skill-worthy. Answer with ONLY "yes" or "no".';
  const user = `User request(s):\n${asks || '(none captured)'}\n\nAssistant used ${toolCount} tools this turn.\n\nSkill-worthy? yes or no:`;
  try {
    const res = await fetch(classifier.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: classifier.model,
        temperature: 0,
        max_tokens: 4,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return true;
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const answer = (body.choices?.[0]?.message?.content ?? '').trim().toLowerCase();
    // Default to reviewing unless the model clearly said no.
    return !/^\s*no\b/.test(answer);
  } catch {
    return true;
  }
}

async function runLearningReview(
  config: PollLoopConfig,
  routing: RoutingContext,
  messages: MessageInRow[],
  continuation: string | undefined,
  reviewPrompt: string = LEARNING_REVIEW_PROMPT,
  opts: { announceDecline?: boolean } = {},
): Promise<void> {
  const announceDecline = opts.announceDecline !== false;
  appendStatusEvent('start', null);
  const originDests = resolveOriginDestinations(messages);
  const query = config.provider.query({
    prompt: reviewPrompt,
    continuation,
    cwd: config.cwd,
    systemContext: config.systemContext,
    learningReview: true,
  });
  try {
    for await (const event of query.events) {
      if (event.type !== 'activity') {
        log(`Learning review: ${event.type}${event.type === 'error' ? ` — ${event.message}` : ''}`);
      }
      if (event.type === 'result') {
        // The one-sentence outcome ("drafted X" / "nothing worth keeping") goes
        // back to the room like any turn reply. The draft itself — if any —
        // already traveled via propose_skill when the tool fired.
        if (event.text) {
          // Auto-triggered reviews stay SILENT unless they found something —
          // the in-room draft card is the announcement. Posting "nothing worth
          // keeping" after every busy turn is noise nobody asked for.
          if (!announceDecline) {
            query.end();
            continue;
          }
          const { sent } = dispatchResultText(event.text, routing, originDests, config.lenientOutput ?? false);
          if (sent === 0) {
            // A review's outcome is ALWAYS for the room that pressed /learn — an
            // unwrapped one-liner here is the normal shape, not scratchpad. (The
            // decline case hit exactly this: a correct "nothing worth keeping"
            // that the user never saw.)
            writeMessageOut({
              id: generateId(),
              kind: 'chat',
              platform_id: routing.platformId,
              channel_type: routing.channelType,
              thread_id: routing.threadId,
              content: JSON.stringify({ text: event.text }),
            });
          }
        }
        query.end(); // no follow-ups ever — let the SDK wind down
      } else if (event.type === 'init') {
        // The fork's session id. NOT saved, on purpose: the next real turn must
        // resume the main conversation, unaware the review ever happened.
      } else if (event.type === 'error' && !event.retryable) {
        // Say so in the room. Silently logging leaves the user a thinking bubble
        // that ends in nothing — and a rate-limited review is worth retrying.
        log(`Learning review failed: ${event.message}`);
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({
            text: `Couldn't run the skill review (${event.message}). Nothing was lost — send /learn again in a bit.`,
          }),
        });
        break;
      }
    }
  } catch (err) {
    log(`Learning review error: ${err instanceof Error ? err.message : String(err)}`);
    query.abort();
  } finally {
    appendStatusEvent('done', null);
  }
}

function deliverErrorResult(text: string, routing: RoutingContext): void {
  log('Error result with no <message> envelope — delivering to channel');
  text = redactSecrets(text);
  writeMessageOut({
    id: generateId(),
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text }),
  });
}

/**
 * Parse the agent's final text for <message to="name">...</message> blocks
 * and dispatch each one to its resolved destination. Text outside of blocks
 * (including <internal>...</internal>) is scratchpad — logged but not sent.
 *
 * The agent must always wrap output in <message to="name">...</message>
 * blocks, even with a single destination. Bare text is scratchpad only.
 */
/**
 * Resolve the channel destination(s) this turn's batch arrived from. A reply
 * defaults back here (see dispatchResultText's origin guard). Returns one entry
 * per distinct (channel_type, platform_id) in the batch — usually one, but an
 * agent-shared session can batch messages from several rooms, and a reply to
 * ANY of them is a legitimate origin.
 */
function resolveOriginDestinations(messages: MessageInRow[]): DestinationEntry[] {
  const seen = new Set<string>();
  const dests: DestinationEntry[] = [];
  for (const m of messages) {
    if (!m.channel_type || !m.platform_id) continue;
    const key = `${m.channel_type}:${m.platform_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const d = findByRouting(m.channel_type, m.platform_id);
    if (d) dests.push(d);
  }
  return dests;
}

export interface TaskMessageBlock {
  to: string;
  body: string;
}

/**
 * Parse the agent's final text for <message to="name">...</message> blocks and
 * dispatch each. Text outside blocks is scratchpad.
 *
 * Origin guard: a SINGLE reply that resolves to a *channel* the batch did not
 * come from is almost always the model mis-picking a destination name (the
 * "agent answered in the wrong room" bug). When that happens we redirect the
 * block to the originating room. Deliberate cross-room sends still work — they
 * either address multiple destinations (multiple <message> blocks) or target an
 * agent-to-agent peer (type 'agent', never guarded). `originDests` is empty in
 * unit tests, which disables the guard (no behavior change for those paths).
 */
export function dispatchResultText(
  text: string,
  routing: RoutingContext,
  originDests: DestinationEntry[] = [],
  lenient = false,
): { sent: number; hasUnwrapped: boolean; taskBlocks: TaskMessageBlock[] } {
  const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;

  // Collect blocks first so the guard can see whether this is a lone reply
  // (the misfire signal) vs. a deliberate multi-destination response.
  let match: RegExpExecArray | null;
  let sent = 0;
  // <message to> blocks left inert in a task run — drives the same-turn
  // "use send_message" nudge in processQuery.
  const taskBlocks: TaskMessageBlock[] = [];
  let lastIndex = 0;
  const scratchpadParts: string[] = [];
  const blocks: { toName: string; body: string }[] = [];
  while ((match = MESSAGE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      scratchpadParts.push(text.slice(lastIndex, match.index));
    }
    blocks.push({ toName: match[1], body: match[2].trim() });
    lastIndex = MESSAGE_RE.lastIndex;
  }
  if (lastIndex < text.length) {
    scratchpadParts.push(text.slice(lastIndex));
  }

  // Channel origins of this batch + the room to redirect a misfire to (prefer
  // the routing's room — extractRouting's first message — else any batch room).
  const originChannels = originDests.filter((d) => d.type === 'channel');
  const originSet = new Set(originChannels.map((d) => `${d.channelType}:${d.platformId}`));
  const primaryOrigin =
    originChannels.find((d) => d.channelType === routing.channelType && d.platformId === routing.platformId) ??
    originChannels[0];
  // The exact destination this turn was triggered FROM — a channel OR an a2a
  // caller (type 'agent'). findByRouting resolves the agent case by
  // agent_group_id. primaryOrigin is channel-only, so it's undefined for an a2a
  // turn; triggerOrigin is what lets a reply find its way back to the caller.
  const triggerOrigin = findByRouting(routing.channelType, routing.platformId);

  for (const { toName, body } of blocks) {
    // One-door delivery in task sessions: only the send_message tool delivers.
    // A final-text <message to> block here is either an echo of a tool send the
    // agent already made (the double-delivery class) or a send down the wrong
    // path — never deliver it, keep it visible in the scratchpad/run log.
    if (routing.taskRun) {
      log(`Task run: <message to="${toName}"> block not delivered — task sessions send only via explicit tools`);
      scratchpadParts.push(
        `[not delivered — task sessions send only via the send_message tool; to="${toName}"] ${body}`,
      );
      taskBlocks.push({ to: toName, body });
      continue;
    }
    let dest = findByName(toName);
    if (!dest) {
      log(`Unknown destination in <message to="${toName}">, dropping block`);
      scratchpadParts.push(`[dropped: unknown destination "${toName}"] ${body}`);
      continue;
    }
    // Single-reply misfire guard. A lone reply to a channel the turn did NOT come
    // from is usually the model mis-picking a destination. Redirect to the origin:
    // the batch's room (primaryOrigin), or — for a weak (lenient) agent answering
    // an a2a call — the agent that called it (triggerOrigin). A small model often
    // ignores its caller and replies into a room it can see in its destination
    // list, leaking the answer to the room instead of back to the caller. Scoped
    // to lenient so a capable agent's deliberate room-post during an a2a turn is
    // untouched.
    const redirectTarget = primaryOrigin ?? (lenient ? triggerOrigin : undefined);
    if (
      blocks.length === 1 &&
      dest.type === 'channel' &&
      redirectTarget &&
      !originSet.has(`${dest.channelType}:${dest.platformId}`)
    ) {
      log(
        `Reply addressed to "${dest.name}" but the turn came from "${redirectTarget.name}" — ` +
          `redirecting to origin (single-reply misfire guard)`,
      );
      dest = redirectTarget;
    }
    sendToDestination(dest, body, routing);
    sent++;
  }

  const scratchpad = stripInternalTags(scratchpadParts.join(''));

  if (scratchpad) {
    log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);
  }

  let hasUnwrapped = !routing.taskRun && sent === 0 && !!scratchpad;
  // Lenient output (small local models): a weak model often can't emit the
  // <message to="..."> envelope, so its plain prose is captured as scratchpad
  // and dropped — the room stays silent turn after turn. When lenient mode is on
  // (the host sets it for ollama-backed agents) and there's an unambiguous
  // origin room, deliver the prose to that room instead of dropping it. This
  // also clears hasUnwrapped, which suppresses the upstream re-wrap nudge — a
  // model that can't wrap would only fail it again, re-hammering a slow local
  // endpoint. Purely-internal output (only an <internal> block) strips to an
  // empty scratchpad above, so this never sends an empty message.
  // Deliver unwrapped prose back to whoever triggered the turn — the a2a caller
  // when that's the source, NOT a room the small model never came from (channel-
  // only primaryOrigin would leak an a2a reply to a room). Falls back to the
  // batch's room for a normal channel turn.
  const lenientTarget = triggerOrigin ?? primaryOrigin;
  if (hasUnwrapped && lenient && !routing.taskRun && lenientTarget) {
    log(`Lenient output: no <message> envelope — delivering prose to origin "${lenientTarget.name}"`);
    sendToDestination(lenientTarget, scratchpad, routing);
    sent++;
    hasUnwrapped = false;
  }
  if (hasUnwrapped) {
    log(`WARNING: agent output had no <message to="..."> blocks — nothing was sent`);
  }
  return { sent, hasUnwrapped, taskBlocks };
}

/**
 * Should this task-run result get the same-turn "your <message> block was
 * not delivered — use send_message" nudge? True at most once per turn
 * (mirrors the unwrappedNudged flag for chat turns).
 */
export function shouldNudgeTaskBlocks(
  taskRun: boolean,
  taskBlocks: TaskMessageBlock[],
  alreadyNudged: boolean,
): boolean {
  return taskRun && taskBlocks.length > 0 && !alreadyNudged;
}

export function buildTaskBlockNudge(taskBlocks: TaskMessageBlock[], destinationNames: string): string {
  const blocks = taskBlocks
    .map(
      ({ to, body }) =>
        `<undelivered_message to="${escapePromptXml(to)}">${escapePromptXml(body)}</undelivered_message>`,
    )
    .join('\n');
  return (
    '<system>The final-output content below was not delivered from this task run:\n' +
    `${blocks}\n` +
    'If and only if any of it still needs to be sent, call send_message with an explicit to destination. ' +
    'If it was already sent or no notification is required, do not send it again. ' +
    `Your destinations: ${escapePromptXml(destinationNames)}. ` +
    'The original task result is already recorded in the run log; do not repeat it.</system>'
  );
}

function escapePromptXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Task runs: the final text is the automatic run summary. Explicit
 * `ncl tasks append-log` calls are additive mid-run notes. Written as a
 * `task_log` outbound row; the host appends it to the series' tasks/<id>.md
 * with its usual timestamp stamp. Never delivered to anyone.
 */
export function autoAppendTaskLog(text: string): void {
  // Run-log hygiene: an inert <message to> block never belongs in the log as
  // raw XML — replace each with its inner text, marked undelivered, so the
  // log stays readable prose.
  const prose = text.replace(
    /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g,
    (_m, to: string, body: string) => `[undelivered → ${to}] ${body.trim()}`,
  );
  const line = stripInternalTags(prose).replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!line) return;
  writeMessageOut({
    id: generateId(),
    kind: 'task_log',
    content: JSON.stringify({ text: line }),
  });
  log('Task run log auto-appended from final text');
}

function sendToDestination(dest: DestinationEntry, body: string, routing: RoutingContext): void {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  // Resolve thread_id per-destination from the most recent inbound message
  // that came from this same channel+platform. In agent-shared sessions,
  // different destinations have different thread contexts — using a single
  // routing.threadId would stamp one channel's thread onto another.
  const destRouting = resolveDestinationThread(channelType, platformId);
  writeMessageOut({
    id: generateId(),
    in_reply_to: destRouting?.inReplyTo ?? routing.inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: destRouting?.threadId ?? null,
    content: JSON.stringify({ text: body }),
  });
}

/**
 * Find the thread_id and message id from the most recent inbound message
 * matching the given channel+platform. Returns null if no match found.
 */
function resolveDestinationThread(
  channelType: string,
  platformId: string,
): { threadId: string | null; inReplyTo: string | null } | null {
  try {
    const db = getInboundDb();
    const row = db
      .prepare(
        `SELECT thread_id, id FROM messages_in
         WHERE channel_type = ? AND platform_id = ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(channelType, platformId) as { thread_id: string | null; id: string } | undefined;
    if (row) return { threadId: row.thread_id, inReplyTo: row.id };
  } catch (err) {
    log(`resolveDestinationThread error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
