# Thread engaged agents (webchat)

Status: **built but DORMANT.** The subsystem (the `webchat_thread_engaged` table,
`resolveEngagedDecision`, the `/engaged` routes, the `setEngagedResolver` router
hook) is implemented and unit-tested but shipped OFF: `setEngagedResolver` is
never called, so the engaged set has no routing effect, and the `/engaged` HTTP
routes are gated behind `ENGAGED_AGENTS_ENABLED = false` (they fall through to
404). Threads route mention-only, like the regular chat. To re-enable: flip
`ENGAGED_AGENTS_ENABLED` AND add the `setEngagedResolver` wiring. The design
below is the intended model for that future re-enable. Webchat-scoped, but the
routing changes land in core host files that the webchat skill already hooks
(see §13).

## 1. Goal & model

Inside a webchat **thread** (not the regular chat), agents can be **engaged**:

- **Add** = `@mention` an agent (a wired member of the room) → it joins the
  thread's **engaged set**.
- **Remove** = click the **×** on its chip above the composer → it leaves the set.
- **Engaged = listening.** All engaged agents **receive** every message in the
  thread (into their per-thread session, for context), but only the **addressed**
  agent is *expected* to reply; others get a **defer** hint and stay quiet unless
  they can clearly add value.
- **Peer fan-out:** when an engaged agent replies, that reply is delivered to the
  *other* engaged agents as context (`isPeerReply`, defer) so the room stays
  coherent without reply cascades.
- **Backfill:** a newly- or re-engaged agent gets recent thread history.

The **regular chat** (thread = `main`/null) is unaffected — it stays strictly
mention-only (no engagement, no stickiness). Engagement is a **per-thread
overlay** that only applies to non-`main` threads.

This mirrors `Artificer-Innovations/nanoclaw-webchat`'s "engaged agents" model.
**Phase 1** = explicit `@` + broadcast/defer + peer fan-out + backfill.
**Phase 2** = implicit-mention detection ("lean") + optional auto-disengage.

## 2. What already exists (reuse, don't rebuild)

- **`trigger` flag on `messages_in`** (`trigger: wake ? 1 : 0`, router.ts:572) is
  exactly the addressed-vs-defer lever. `trigger:1` wakes the container (reply
  expected); `trigger:0` is stored as **context only** — the poll loop's
  accumulate gate (`poll-loop.ts:153`) skips waking when a batch has no
  `trigger:1` row. So a non-addressed engaged agent gets the message with
  `trigger:0` and simply doesn't respond. No new "defer engine" needed.
- **`content` is a JSON blob** (the only free-form column on `messages_in`).
  Routing hints (`responseExpectation`, `engagedAgents`, `isPeerReply`) ride
  inside it — **no schema migration** for the hint channel.
- **Per-thread sessions** via `resolveSession(..., 'per-thread')` (router.ts:513);
  `findSessionForAgent(agent, mg, threadId)` (sessions.ts:36) for lookup/backfill.
- **Reply fan-out already works**: webchat `deliver()` loops an agent's reply back
  through the router via `onInbound(...)` (channels/webchat/index.ts:239-263), with
  producer self-exclusion (router.ts:309). Peer fan-out = scoping this to the
  engaged set.
- **Live updates**: `server.broadcast(roomId, {...})` (channels/webchat/state.ts)
  + the client WS `switch(msg.type)` (app.js:1010) — add one event type.
- **History sync** on engage: `syncSessionContext` (session-manager.ts:310).

## 3. Data model (new)

One new webchat-owned table (migration in `channels/webchat/migration.ts`,
helpers in `channels/webchat/db.ts`):

```sql
CREATE TABLE webchat_thread_engaged (
  room_id        TEXT NOT NULL,
  thread_id      TEXT NOT NULL,          -- never 'main' (regular chat can't engage)
  agent_group_id TEXT NOT NULL,
  engaged_at     INTEGER NOT NULL,
  PRIMARY KEY (room_id, thread_id, agent_group_id)
);
CREATE INDEX idx_webchat_engaged_thread ON webchat_thread_engaged (room_id, thread_id);
```

Helpers: `engageAgent(room, thread, agentGroupId)`, `disengageAgent(...)`,
`getEngagedAgents(room, thread) → agentGroupId[]`, and cascade deletes in
`deleteWebchatThread` / `deleteWebchatRoom` (mirror the existing prime cleanup).

## 4. Routing (the core change — `src/router.ts`)

In the fan-out loop (`routeInbound`, ~router.ts:300-368), for **webchat
group rooms on a non-`main` thread**, resolve the engaged set once and change the
per-agent decision:

```
engaged = getEngagedAgents(roomId, threadId)            // [] for 'main'/regular chat
explicit = folders @mentioned in the message
// @mention auto-engages:
for f in explicit: if f not in engaged: engageAgent(...) ; engaged += f ; broadcast change

for agent in wiredAgents:
  if threadId is regular-chat OR engaged is empty:
     → existing mention-only behavior (unchanged)
  else if agent in engaged:
     addressed = agent.folder in explicit (Phase 2: or in implicitMentions)
     write to agent's per-thread session with:
        trigger = addressed ? 1 : 0
        content.responseExpectation = addressed ? 'expected' : 'defer'
        content.engagedAgents = engaged
     (if newly engaged this turn → backfill first, §7)
  else:
     skip (not engaged, not addressed → silent)
```

- **Regular chat / no engaged set** → zero behavior change (mention-only).
- The hint keys are added to `event.message.content` (JSON) before
  `writeSessionMessage` (router.ts:564) — no new columns.
- `responseExpectation` is **guidance**, enforced softly: `trigger:0` already
  prevents a wake, and the in-prompt hint tells an addressed-but-deferring agent
  to use judgment. (Matches the reference: agents retain judgment.)

## 5. The defer hint (agent-runner — `formatter.ts`)

`formatSingleChat` (formatter.ts:169) already runs `parseContent(msg.content)`.
Read the new keys and surface them to the model, e.g.:

```
<message id=… sender=… expectation="defer" peer="true">…</message>
```

and a one-line preamble in the system/turn context: *"You're engaged in this
thread for context. Reply only when addressed (expectation="expected") or when
you can add clear value; otherwise stay silent."* Container formatter is **not**
currently webchat-hooked — adding it to the hook set is part of this work (§13).

## 6. Peer fan-out (`channels/webchat/index.ts` loop-back)

The existing loop-back (`deliver()` → `onInbound`) is the hook. When an engaged
agent replies in a thread:

- Re-enter the router with the synthetic inbound marked
  `content.isPeerReply = true` and the engaged set.
- Router writes it to the **other engaged agents'** sessions with `trigger:0` +
  `responseExpectation:'defer'` (context only — never triggers a reply), skipping
  non-engaged wirings and the producer (existing self-exclusion).
- Best-effort, async (already the case); rate-limited by `shouldLoopBack`.

## 7. History backfill on (re)engage

When `engageAgent` adds an agent that has **no** session for the thread (or a
stale one), seed its per-thread session with recent thread history before live
traffic, via `syncSessionContext` (session-manager.ts:310) over the thread's
recent `webchat_messages`. Prevents a cold-start mid-conversation.

## 8. Add / remove flows + API + WS

- **Engage (add):** implicit on `@mention` (router auto-engages, §4) **and** an
  explicit endpoint for the UI optimistic path:
  `POST /api/rooms/:id/threads/:tid/engaged  { agentGroupId }`.
- **Disengage (remove, ×):** `DELETE /api/rooms/:id/threads/:tid/engaged/:agentGroupId`.
  Deletes the row; the agent stops receiving. (Does **not** delete its session —
  re-engage reuses/ backfills it.)
- **List:** `GET /api/rooms/:id/threads/:tid/engaged → [{agentGroupId, name, folder}]`.
- **Live:** on any change, `server.broadcast(roomId, { type:'engaged_set_changed',
  thread_id, engaged:[…] })`; client updates chips.

All mutating routes carry the `X-Webchat-CSRF` header; owner/member access via
the existing `canAccessRoom`.

## 9. Chips UI (`public/webchat/`)

- A chips row inserted as a sibling **immediately before `#message-form`**
  (after `#file-preview`, index.html:324). One chip per engaged agent:
  `«glyph name ×»`. Hidden when the engaged set is empty or in the regular chat.
- `@mention` accept (`acceptMention`, app.js:3487) optimistically adds a chip +
  POSTs engage. `×` → DELETE + remove chip.
- `engaged_set_changed` WS event (new `case` ~app.js:1177) re-renders chips.
- Styling reuses the chip/token language; `×` follows the dismissal pattern.

## 10. Phase 2 — implicit mentions + auto-disengage

- **Implicit mentions:** name-in-address-position detection (`Rahul — …`,
  `hey Diego`, `Mei, thoughts?`) against engaged agents' folder/display name →
  `responseExpectation:'lean'` (still `trigger:1`, softer prompt than `expected`).
  Word-boundary, case-insensitive, address-position-gated, excludes citations
  (`as Rahul said`) and code/quoted spans. Implicit mentions do **not** engage —
  only `@` does.
- **Auto-disengage (optional):** TTL on `engaged_at` (idle sweep) — deferred;
  ship only if threads accumulate stale chips in practice.

## 11. Regular-chat scoping (invariant)

Engagement applies **only** to non-`main` threads. The router gate is explicit:
`if (threadId == null || threadId === 'main') → mention-only path, never consult
the engaged set`. This preserves the "no agents reply unless @-mentioned"
behavior just shipped for the regular chat, and is the reason engaged state is a
separate table rather than reusing `mention-sticky` (whose session-existence
signal can't distinguish the always-present regular-chat session).

## 12. Build phases (each ends green: typecheck + tests + GUI check)

1. **Data model** — table + migration + db helpers + cascade deletes. Unit test.
2. **Engaged API + chips UI** — endpoints, WS event, chips render/add/remove.
   Validatable in the GUI on its own (engage/disengage shows/hides chips), even
   before routing honors it.
3. **Routing** — engaged-set resolution in the fan-out loop; addressed→trigger:1,
   other-engaged→trigger:0 + hint; `@` auto-engages; regular-chat gate. Tests:
   regular chat unchanged; engaged agent receives but defers; addressed replies.
4. **Defer hint** — formatter surfaces `expectation`/`peer`; turn preamble.
5. **Peer fan-out** — scope loop-back to the engaged set as `isPeerReply` defer.
6. **Backfill** — seed history on (re)engage.
7. **Phase 2** — implicit-mention parser → `lean`; (optional) TTL.
8. **Docs** — CLAUDE.md threads section + this doc → built.

## 13. Hook coordination / mergeability (read before publishing)

Webchat-owned files (`src/channels/webchat/*`, `public/webchat/*`) are skill
`NEW_PATHS` — free to change. But this feature edits **core/trunk files the
webchat skill hooks**: `src/router.ts`, `src/delivery.ts`, `src/db/session-db.ts`,
`src/db/schema.ts`, `src/types.ts`, `container/agent-runner/src/poll-loop.ts`,
`src/session-manager.ts` are already in `install-webchat.sh` `HOOK_FILES` +
`verify-webchat-publish.sh` allowlist. **Newly drawn into the hook surface** by
this work: `container/agent-runner/src/formatter.ts` and (if a column is ever
added) `container/agent-runner/src/db/messages-in.ts`, `src/db/sessions.ts` —
these must be **added to `HOOK_FILES`, the uninstall reverse list, and the
verifier allowlist**.

Protocol (same as any webchat-hooked trunk change): land on trunk → re-derive
channels-webchat's hooked copies on the new trunk → `verify-webchat-publish.sh
--full` green → only then publish. Using `content`-JSON for hints (not a
`messages_in` column) deliberately keeps the schema/migration surface — and thus
the hook surface — minimal.

## 14. Thread context sync (pull / push) — moved to its own spec

The "snapshot main → thread" and "push thread → main" idea is now fully specced in
**[thread-context-sync.md](thread-context-sync.md)**: symmetric,
verbatim, additive pull/push with per-direction high-water marks (incremental, no
duplicates), origin-marked copies, demarcation dividers, header controls shown
in-thread, and a phased build plan. It moves *messages* (transcript + agent
session), independent of the engaged-agents model.
