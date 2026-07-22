# Outbound delivery: crash semantics audit ("delivery-obligation ledger")

Status: **audit — no fix needed.** Question examined: if the host process dies
at the wrong moment, can a final agent response be (a) silently lost or
(b) duplicated on the platform? Answer: **loss — no; duplicate — yes, in a
window measured in the tail of one awaited network call (network channels) or
sub-millisecond synchronous JS (webchat).** The pipeline is already
at-least-once with boot-time redelivery; duplicates are the deliberate and
correct side of that trade-off. This doc records the trace so the question
doesn't need re-answering.

All line numbers refer to the tree at the time of the audit
(branch `audit/delivery-crash-window`, off `channels-webchat` 3643579a).

## 1. The ledger, as built

The "obligation ledger" already exists, split across the two session DBs:

- **Obligation**: the container writes the reply to `messages_out` in the
  session's `outbound.db` (`container/agent-runner/src/db/messages-out.ts:45`,
  `writeMessageOut`). Durable the moment the INSERT commits — container-owned
  file, host never writes it.
- **Discharge**: the host records completion in the **`delivered` table of
  `inbound.db`** (host-owned) — never a row delete, never a flag on
  `messages_out` (`src/db/session-db.ts:329` `markDelivered`,
  `:335` `markDeliveryFailed`, both `INSERT OR IGNORE`).
- **Membership check**: each drain pass recomputes
  `due(outbound.db) − delivered(inbound.db)` (`src/delivery.ts:218-224`).
  `getDeliveredIds` (`session-db.ts:321`) has **no status filter** — a
  `status='failed'` row also counts as discharged (see §4).

`processing_ack` (synced in `src/host-sweep.ts:226-228`) is the **inbound**
ledger (did the container process `messages_in`); it plays no role in outbound
delivery and is out of scope here.

## 2. Mark-vs-send ordering — generic path

Per message, in `drainSession` (`src/delivery.ts:229-266`):

```
231   const platformMsgId = await deliverMessage(msg, session, inDb);  // ← adapter send, awaited
232   markDelivered(inDb, msg.id, platformMsgId ?? null);              // ← mark, AFTER confirm
```

Inside `deliverMessage`, the actual platform send is
`await deliveryAdapter.deliver(...)` (`src/delivery.ts:424-433`); after it
resolves the only work before the mark is synchronous: `log.info` (`:434`),
`clearOutbox` (`:442` — sync `fs.rmSync`, best-effort, swallows errors
precisely so a cleanup failure can't trigger a double-send;
`src/session-manager.ts:635`), return through one microtask hop, then the
`markDelivered` INSERT (better-sqlite3, sync).

**Ordering: send → confirm → mark. Strictly at-least-once.**

Crash windows on this path:

| Crash lands… | Outcome | Window size |
|---|---|---|
| Before the adapter call starts | Row stays undelivered; **redelivered after restart** (§3). No loss. | n/a |
| After the platform commits the send, before its HTTP response reaches the host | Platform has the message, host never marks → **duplicate** on restart | The response leg of the awaited network round-trip — realistically tens to low hundreds of ms for Chat-SDK channels |
| Between the adapter promise resolving and `markDelivered` committing | Same duplicate | Synchronous JS + one `rmSync` + one INSERT — sub-millisecond; only a hard kill (SIGKILL, power loss) can land here |

There is **no ordering anywhere that marks before sending**, so there is no
loss-direction crash window. The historical one — the delivery bridge
returning `undefined` when no adapter was registered, which made `drainSession`
mark a never-sent row delivered (#2995) — is fixed in this tree:
`createChannelDeliveryAdapter` **throws** `MissingChannelAdapterError`
(`src/channels/channel-registry.ts:80-91`, throw at `:118-119`), routing the
row into the retry path instead. The webchat `reconcile.ts` watchdog that was
written against that bug is now belt-and-braces (see §5).

## 3. Redelivery after restart

Undelivered rows cannot strand across a host restart:

- `pollSweep` covers **all** `status='active'` sessions and runs its first
  pass immediately when started (`src/delivery.ts:146-150`, `170-188`); the
  active poll (1s) covers running/idle containers (`:152-168`). Both start at
  boot right after the adapter is set (`src/index.ts` step 4 `setDeliveryAdapter`
  → step 5 `startActiveDeliveryPoll`/`startSweepDeliveryPoll`), so the
  `!deliveryAdapter → return → mark` path in `deliverMessage`
  (`src/delivery.ts:286-289`) is unreachable in the real boot order.
- The `deliveryAttempts` counter is **in-memory** (`src/delivery.ts:44-45`),
  so a restart deliberately grants failed-but-not-yet-marked-failed messages a
  fresh set of attempts.
- The `inflightDeliveries` set (`:60`) prevents the 1s and 60s pollers from
  double-sending the same row intra-process; cross-process it's irrelevant
  (single host).

## 4. Non-crash loss paths (recorded for honesty, out of scope)

These are failure-semantics decisions, not crash windows:

- **Permanent fail after 3 attempts** (`MAX_DELIVERY_ATTEMPTS`,
  `src/delivery.ts:42`, `:244-264`): three throws → `markDeliveryFailed` →
  the row counts as discharged forever (no status filter in
  `getDeliveredIds`). With a 1s poll, a channel outage of ~3s is enough to
  drop a reply permanently (loud in `logs/nanoclaw.error.log`). There is no
  dead-letter redelivery. If this ever bites in practice, the minimal change
  is upstream-shaped: exclude `status='failed'` rows older than N from the
  discharged set on boot, or add an `ncl` resurrect verb — not fork material.
- **Intentional mark-without-send returns** in `deliverMessage`: `task_log`
  rows (append to run log, `:303-315`), missing routing fields (`:411-414`),
  webchat unknown room (`src/channels/webchat/index.ts:234-237`), webchat
  approval-inbox non-`ask_question` payloads (`:224-229`). All deliberate
  drops with logging.
- **Task-session GC race** (`src/host-sweep.ts:278-288`): a spent task
  session is closed without checking for undelivered channel-addressed rows
  in its `outbound.db`; a closed session leaves both delivery poll sets, so a
  send_message emitted in the task's final turn could strand if the GC tick
  beats the delivery sweep tick while the adapter is erroring. Narrow
  (requires container exited + zero live task rows + delivery not yet
  drained), independent of host crashes, upstream-owned code. Noted, not fixed.

## 5. Webchat path

`deliver()` in `src/channels/webchat/index.ts:197-305`. For a chat message to
a known room, the "platform" is local:

1. `storeWebchatMessage` — sync INSERT into `webchat_messages` in the central
   `v2.db` (`:253`);
2. `server.broadcast` — fire-and-forget WS frame (`:254`);
3. loop-back fan-out re-entering the router (`:279-303`);
4. return → `markDelivered` in the session's `inbound.db`.

Semantics:

- **Crash between store and broadcast**: nothing lost — the row is in
  `webchat_messages` and the PWA refetches history on reconnect. (This is why
  store-before-broadcast is the right order.)
- **Crash between store and `markDelivered`**: duplicate-direction, same as
  the generic path but with two webchat-specific amplifiers: redelivery
  inserts a **second permanent `webchat_messages` row** (visible duplicate in
  room history, survives refetch), and the loop-back fan-out **fires again**,
  so other wired agents can react to the duplicate. Bounded by the router's
  self-exclusion/prime-skip and the per-room loop-back rate limiter
  (`:344-370`), and the window is pure synchronous JS between two local
  SQLite inserts — sub-millisecond. Not worth a dedup key.
- `reconcile.ts` (`src/channels/webchat/reconcile.ts`) replays
  outbound-vs-`webchat_messages` mismatches from the last 60s on a 7s timer,
  with content+time-band probing for idempotency. It was the workaround for
  pre-#2995 trunk; with the throw in place it's a residual safety net, and it
  is **loss-correcting only** — it never causes duplicates for
  regularly-delivered rows because it probes before replaying.

## 6. Verdict

- **Loss window: none.** Every path either marks after the awaited send
  confirms, or is an intentional logged drop. Durable obligation + boot-time
  sweep = at-least-once.
- **Duplicate window: yes, inherent and acceptable.** Generic channels: the
  response leg of one awaited network call plus microseconds of sync work.
  Webchat: sub-millisecond, but a duplicate there is permanent in history and
  can re-trigger loop-back — still not worth engineering exactly-once for a
  hard-kill landing in a sub-ms window.
- **No code change made.** A fix would only make sense as exactly-once
  (platform-side idempotency keys per channel), which no platform here
  uniformly supports, or as a webchat dedup key on redelivery — both
  upstream-shaped changes disproportionate to the window. The
  fork-relevant ownership fact: the entire mark/retry/fail loop in
  `drainSession` is **upstream code untouched by this fork** (the fork's
  `delivery.ts` delta is status-forwarding + sender-source threading only),
  so any future change here must go upstream, not into the webchat hooks.
