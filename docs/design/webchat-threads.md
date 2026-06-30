# Per-room threads (webchat)

Status: **built** — shipped on `channels-webchat`, delivered by
`install-webchat.sh` like the rest of the webchat skill. Decisions taken:
**sidebar-nested** thread UI, and per-agent lanes via **confirm-first
suggestion** (NOT silent auto-spawn — see §5). The sections below are the
design; where the implementation differs it is noted inline (notably §5, and
inbound thread_id is bounded — only 'main', a wired-agent lane, or an existing
topic thread routes; an unknown id falls back to main rather than spawning).

A thread starts with no context (its own session). To move conversation between
a thread and the room's regular chat, see
**[webchat-thread-context-sync.md](webchat-thread-context-sync.md)** (verbatim,
additive pull ↓ / push ↑ with per-thread high-water marks).

## 1. Goal & model

Let one webchat room hold several **independent conversations** with its agent(s),
each with its own context — instead of every message collapsing into one
ever-growing session.

The load-bearing idea: in NanoClaw, **a thread is an agent session.** `thread_id`
is already part of the session key — `resolveSession(agentGroup, messagingGroup,
threadId, 'per-thread')` returns **one session per (room, thread)**, and each
session has its own container context, its own continuation (the Claude
transcript), its own `inbound.db`/`outbound.db`, and its own heartbeat. So a
thread is a real, isolated conversation:

- ✅ topic isolation — no context bleed between unrelated threads
- ✅ smaller per-turn context → cheaper + faster
- ✅ parallel topics with one agent
- ⚠️ **no cross-thread awareness** by design — the agent answering in thread A
  cannot see thread B (different session). This is the point of threads, but it
  must be stated plainly in the UI.

The rejected alternative — threads as a pure UI grouping over one shared session
— reintroduces the context bleed threads exist to remove and fights the session
model. Not pursued.

## 2. What already exists vs. net-new

**Already there (the spine — reused, not built):**
- `thread_id` columns on `sessions`, `messages_in`, `messages_out`,
  `pending_questions`.
- `per-thread` session mode + `resolveSession` keying (`src/session-manager.ts`,
  `src/db/sessions.ts`).
- Router session resolution reads `event.threadId`; `evaluateEngage(...)` already
  receives `threadId` (`src/router.ts`).
- The adapter contract already carries threadId both ways:
  `onInbound(platformId, threadId, message)` and
  `deliver(platformId, threadId, message)` (`src/channels/adapter.ts`).
- The agent's reply is auto-stamped with its session's `thread_id` on every
  outbound row (`writeSessionRouting`, `src/session-manager.ts`).
- `pending_questions.thread_id` — approvals/`ask_user_question` already
  thread-aware.

**The gap (what we build) — the webchat skill severs the thread at both ends:**
- The adapter declares `supportsThreads: false` and calls
  `onInbound(roomId, null, message)` — **nulls out threadId** (`index.ts:87,102`),
  so every room message collapses into one `shared` session.
- `deliver(platformId, _threadId, …)` **ignores** the threadId on the way back
  (`index.ts:152`).
- `webchat_messages` is a flat `(room_id, created_at)` log — **no thread column**.
- The client has no thread concept; it sends `{type:'message', content}` with no
  thread (`app.js:2500`).

So the work is: **stop nulling the thread, store it, route replies back to it,
and give the client a sidebar thread tree.** The routing layer already knows what
to do with a `thread_id` once it is present.

## 3. Data model

Three additions (one new table, one column, one widened key) via a webchat
migration (idempotent, additive):

```sql
-- Thread registry. thread_id becomes session.thread_id for this room.
CREATE TABLE webchat_threads (
  room_id    TEXT NOT NULL,            -- messaging_groups.platform_id
  thread_id  TEXT NOT NULL,            -- 'main' | 'agent:<folder>' | uuid
  title      TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'topic',  -- 'main' | 'agent' | 'topic'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, thread_id)
);

-- Per-thread message history. Default 'main' migrates existing rows cleanly.
ALTER TABLE webchat_messages ADD COLUMN thread_id TEXT NOT NULL DEFAULT 'main';
CREATE INDEX idx_webchat_messages_thread ON webchat_messages(room_id, thread_id, created_at);

-- Per-thread read markers (widen the existing (user_id, room_id) PK to include thread).
-- New table + copy, since SQLite can't alter a PK in place.
CREATE TABLE webchat_thread_reads (
  user_id      TEXT NOT NULL,
  room_id      TEXT NOT NULL,
  thread_id    TEXT NOT NULL,
  last_read_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, room_id, thread_id)
);
```

`thread_id` namespacing:
- **`main`** — every room's implicit default thread (see §7). Created lazily.
- **`agent:<folder>`** — an auto-spawned per-agent lane (§5). Deterministic id so
  repeated mentions of the same agent reuse the same thread/session.
- **`<uuid>`** — a manually-created topic thread.

## 4. Routing flow (the round trip)

**Inbound** (client → agent), example: you send "draft the Q3 roadmap" with the
*Q3 planning* thread selected (`thread_id = u_a1b2`):

1. Client sends `{type:'message', content, thread_id:'u_a1b2'}` (new field).
2. `ws.ts` resolves it and the adapter calls
   `onInbound(roomId, 'u_a1b2', message)` — **passing the thread** instead of null.
3. Router `resolveSession(group, room, 'u_a1b2', 'per-thread')` → session **S1**,
   keyed to that thread. Message lands in **S1's** `inbound.db`; container spawns.
4. `webchat_messages` row stored with `thread_id='u_a1b2'`.

**Outbound** (agent → client):

5. The agent answers in S1; its outbound rows are stamped `thread_id='u_a1b2'`
   automatically (session routing).
6. Delivery calls `deliver(roomId, 'u_a1b2', msg)`; the adapter now **broadcasts
   the threadId** in the WS payload (today dropped).
7. Client renders the reply **inside the Q3 planning thread** and bumps the
   per-thread unread badge for anyone not viewing it.

A second thread (*Incident #4821*, `thread_id=u_c3d4`) keys a **different**
session S2 with zero knowledge of S1 — the agent works both in parallel, each
reply routed to its own thread.

## 5. Auto-spawn (per-agent lanes)

> **Shipped as confirm-first, not silent auto-spawn.** Rather than redirecting a
> single-mention `main` message into a lane automatically (the surprise risk
> noted in §11), the server emits a `thread_suggestion` and the member opts in
> ("Continue with @X in its own thread?"). The trigger rule below (exactly one
> mention, from main, multi-agent room, `auto_thread` on) governs *when the
> suggestion appears*; the redirect only happens on confirm. Everything else
> below still holds.

**Decision: auto-spawn on.** Multi-agent rooms self-organize into per-agent
threads so several agents never get dumped into one shared context.

**Rule (deterministic, v1):**
- Each room has an `auto_thread` flag (in `webchat_room_settings`).
  **Default: on for multi-agent rooms, off for single-agent rooms and DMs**
  (one agent = no benefit).
- When `auto_thread` is on, a **chat message sent in the `main` thread that
  @mentions exactly one wired agent** is routed to that agent's lane
  `thread_id='agent:<folder>'`, auto-creating the `webchat_threads` row
  (kind=`agent`, title = agent's display name) on first use.
- Messages in `main` that mention **zero** agents (human chatter) or **two+**
  agents (a deliberate cross-agent discussion) **stay in `main`**.
- Messages already sent *inside* a thread stay in that thread — auto-spawn only
  acts from `main`.
- Manual topic threads (§6) are unaffected and can be created anytime.
- Per-room opt-out in room settings; never fires for DMs/single-agent rooms.

**Why these bounds:** the trigger is unambiguous (exactly-one-mention, from main),
it degrades to today's behavior when off or single-agent, and "mention two agents
= keep them together in main" is a natural escape hatch.

**Example** — room `#eng` wired to Sarah + Max, `auto_thread` on:
- You (in main): "what's the deploy status?" → no mention → stays in **main**;
  mention-routing in main behaves exactly as today.
- "@sarah draft the Q3 roadmap" → auto-creates/reuses **`agent:sarah`**
  (title *Sarah*), routes there. S_sarah is keyed to that lane.
- "@max check the staging logs" → **`agent:max`** lane, separate session.
- "@sarah @max can you two reconcile the numbers?" → two mentions → **main**;
  both engage together.
- Inside the *Sarah* lane you type "and the headcount section?" → stays in the
  Sarah lane (no re-routing); Sarah continues with her context.

## 6. Sidebar-nested UI (decision)

Threads render **nested under their room** in the left sidebar (matches the
multi-thread scaling of the reference implementation), not as a top tab strip.

```
▾ #eng                3   ← room row; number = total unread across its threads
    # main
    @ Sarah            2   ← per-thread unread badge
    @ Max
    # Q3 planning      •   ← manual topic thread (unread dot)
  ▸ #design
  DMs
    Sarah (dm)
```

- Clicking a room expands/collapses its thread list; clicking a thread opens it
  and loads `GET /api/rooms/:id/messages?thread_id=…` (that thread only).
- **Create** ("+ thread" at the bottom of a room's expanded list) → name prompt →
  `POST …/threads` → opens the new (empty) topic thread.
- **Rename / delete** via the thread's row context menu (owner/member rules
  mirror room settings; reuse the room-rename pattern just shipped).
- Auto-spawned `agent:*` threads appear with the agent glyph + name; `main` is
  pinned first and not deletable; topic threads sort by last activity.
- **Unread** is per-thread (`webchat_thread_reads`); the room row shows the sum.
- Active-thread state persists per session (like `lastRoom`).

Follows `public/webchat/DESIGN.md` — tokens, `showToast`, sentence-case microcopy.

## 7. The `main` thread + migration

- Every room has an implicit **`main`** thread (`kind=main`), created lazily on
  first use. A brand-new room with no threads behaves exactly as today — `main`
  is just the room.
- Migration backfills `webchat_messages.thread_id='main'` (column default), so
  **all existing history lands in `main`** with no data loss and no visible
  change until someone creates/auto-spawns a thread.
- Existing `webchat_room_reads` rows copy into `webchat_thread_reads` as
  `(user_id, room_id, 'main', last_read_at)`.

## 8. Edge cases & decisions

- **DMs** (`dm:<folder>` rooms): single agent → `auto_thread` off; they stay
  single-threaded. Manual topic threads still allowed if wanted.
- **Engage / mention-sticky** is unchanged — it resolves *within the thread's
  session*, so an engaged agent stays engaged **in that thread**, not across the
  room (matches the reference's per-thread engaged state).
- **Approvals / `ask_user_question`**: `pending_questions.thread_id` already
  exists, so a question from S1 surfaces in its thread and the answer routes
  back to S1. No new work.
- **Delete a thread**: remove the `webchat_threads` row + its `webchat_messages`
  + its `webchat_thread_reads`, and tear down its session dir
  (`data/v2-sessions/<group>/<S>/`). Room + other threads untouched. `main` is
  not deletable.
- **What the agent sees**: only its thread's history. If a user expects
  cross-thread memory, the UI states threads are separate conversations.
- **a2a / loop-back**: agent-authored fan-out keeps its existing self-exclusion;
  it inherits the thread of the session that produced it.

## 9. Build phases (each ends green: typecheck + tests)

0. **Schema + storage** — migration (`webchat_threads`, `thread_id` column,
   `webchat_thread_reads`), thread CRUD helpers in `db.ts`, message read/write
   filtered by thread, read-marker helpers. Backfill `main`. Unit-tested.
1. **Adapter plumbing** — stop nulling threadId on inbound; honor threadId in
   `deliver` + broadcast; drive per-thread session mode for webchat rooms.
   Tests: a message with `thread_id=X` keys a session at X; two threads → two
   sessions; reply routes back to its thread.
2. **Server endpoints** — `GET/POST/PATCH/DELETE /api/rooms/:id/threads`;
   `?thread_id=` on the messages endpoint; per-thread read endpoint; thread
   teardown on delete (owner/member-gated, CSRF, mirroring room routes). Tests.
3. **Auto-spawn** — `auto_thread` setting (default per §5); router/adapter logic
   to redirect a single-mention `main` message to `agent:<folder>`. Tests:
   exactly-one-mention from main → agent lane; zero/two mentions → main;
   single-agent/DM never spawns; in-thread messages don't re-route.
4. **Sidebar UI** — nested thread tree, create/rename/delete, per-thread history
   load, send-with-thread, route inbound to the right thread, per-thread unread,
   active-thread persistence.
5. **Packaging** — add new files to `install-webchat.sh` NEW_PATHS / migrations;
   uninstall reverses; install→uninstall round-trip.

## 10. Test plan (highlights)

- **Isolation invariant**: messages to thread A and thread B resolve to distinct
  sessions; A's context never appears in B.
- **Round trip**: inbound `thread_id` → session key → outbound stamped → delivery
  threadId → client renders in-thread.
- **History filter**: `?thread_id=` returns only that thread; `main` holds
  migrated history.
- **Auto-spawn matrix**: the five §5 cases.
- **Unread**: per-thread marker monotonic; room row = sum; cascades on delete.
- **Migration**: existing rooms/messages/reads land in `main` unchanged.
- **Round-trip install/uninstall** on a fresh `channels-webchat` checkout.

## 11. Open questions / risks

- **Client is the riskiest slice** — correctly routing *live* WS messages into
  the right thread node + per-thread unread, without leaking a turn's bubbles
  across threads (reuse `endAllAgentTurns` per-thread).
- **Auto-spawn surprise** — redirecting a `main` mention into a lane is the one
  behavior users might not expect; the per-room opt-out + "two mentions stay in
  main" escape hatch mitigate. Revisit defaults after dogfooding.
- **Session sprawl** — many threads = many sessions/containers. Existing idle
  teardown applies per session, so cold threads cost nothing while idle; worth
  watching on busy multi-agent rooms.

## Effort

~1–2 weeks. Almost entirely additive; no change to non-webchat behavior. The
backend is mostly *using* tested machinery; the UI (slice 4) is the bulk of the
new code. Riskiest: live-message routing in the client.
