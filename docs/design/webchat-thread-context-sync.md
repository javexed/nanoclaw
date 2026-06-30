# Webchat thread context sync (pull / push)

Status: **design / plan** — not built. Webchat-scoped (threads). Composes with
`webchat-threads.md`; supersedes the §14 stub in `thread-engaged-agents.md`.

## 1. Goal & model

A thread is its own session, so a new thread starts with **no context** — both an
empty transcript and an empty agent memory. Two operations move context between a
thread and its room's regular chat ("main"):

- **Pull (↓ from main):** bring main's recent conversation into the thread.
- **Push (↑ to main):** bring the thread's own conversation back into main.

Both are **verbatim**, **additive**, **demarcated**, and **incremental** (a
high-water mark per direction). **Neither ever overwrites or reorders** the
destination — they only append. "Context" = both the visible **transcript**
(`webchat_messages`) *and* the destination agent's **session memory** (written as
silent `trigger:0` inbound, the engaged-work backfill mechanism).

Pull and push are **symmetric**: each appends the messages added in the source
*since the last sync in that direction*, under a divider, and updates that
direction's high-water mark. So repeated use in either direction just brings the
delta — pull on a fresh thread brings the whole recent slice (the original
"snapshot on create"); a later pull brings only what's new in main since.

## 2. What counts as "the thread's own" conversation

A thread's messages split into:

```
[ pulled-in prefix (origin = 'pulled', copied from main) ]  +  [ native thread messages ]
```

**Push appends only the native messages** — never the pulled-in prefix (those rows
already exist in main; re-appending would duplicate). This is why copied messages
are **origin-marked** (§3): push selects `origin IS NULL` (native) thread rows;
pull likewise skips main rows that are `origin='pushed'` from this same thread (so
a push→pull round-trip doesn't echo).

## 3. Data model

**Mark copied rows.** Add a nullable column to `webchat_messages` (additive,
idempotent migration):

```sql
ALTER TABLE webchat_messages ADD COLUMN origin TEXT; -- NULL=native | 'pulled' | 'pushed'
```

Copied rows are **new** `webchat_messages` rows in the destination (new ids,
`created_at` = now so they land at the destination's current end), with `origin`
set and `thread_id` = destination thread. The original rows are untouched.

**High-water marks.** A small per-thread sync-state table:

```sql
CREATE TABLE webchat_thread_sync (
  room_id          TEXT NOT NULL,
  thread_id        TEXT NOT NULL,
  last_pulled_src_ts INTEGER NOT NULL DEFAULT 0, -- newest main created_at pulled in
  last_pushed_src_ts INTEGER NOT NULL DEFAULT 0, -- newest native thread created_at pushed up
  PRIMARY KEY (room_id, thread_id)
);
```

Marks track the **source** message timestamp last synced, so the next sync selects
`src.created_at > mark`. Cascade-delete with the thread (mirror the prime/engaged
cleanup in `deleteWebchatThread` / `deleteWebchatRoom`).

## 4. Pull (main → thread)

```
src = main messages WHERE created_at > last_pulled_src_ts
        AND origin IS NULL            -- don't re-pull pushed-back blocks
        (bounded: also cap to the last N / last window on a fresh pull)
if src empty → no-op ("Nothing new in main to pull")
insert a divider row + copies of src into the thread (origin='pulled')
syncSessionContext(thread session, src)   -- agent memory, trigger:0
last_pulled_src_ts = max(src.created_at)
broadcast the new messages to the room's clients
```

A **fresh** thread's first pull has `last_pulled_src_ts = 0`, so it pulls main's
recent slice (bounded by N/window). That is the "snapshot on create".

## 5. Push (thread → main)

```
src = native thread messages WHERE created_at > last_pushed_src_ts AND origin IS NULL
if src empty → no-op ("Nothing new to push")
insert a divider row + copies of src into main (origin='pushed', thread_id='main')
syncSessionContext(main session, src)      -- main agent memory, trigger:0
last_pushed_src_ts = max(src.created_at)
broadcast
```

Multiple pushes never duplicate: each appends only `created_at >
last_pushed_src_ts`. Push #2 brings only what was added since push #1; with nothing
new it's a no-op toast. Deltas land at main's current end in order.

## 6. Demarcation

Each copied block is preceded by a synthetic divider message (a distinct
`message_type`/kind, e.g. `context-divider`, with text *"Pulled from main"* /
*"Pushed from #threadtitle"* and a timestamp). The client renders it as a labeled
rule so imported content is never confused with native conversation. Dividers are
display-only — they are NOT written to agent sessions.

## 7. UI

- **Two header controls**, in the chat header **to the right of the room name**,
  shown **only when a thread is open** (`currentThread !== 'main'`) — pull/push are
  meaningless in the regular chat:
  - **↓ from main** — pull.
  - **↑ to main** — push.
- **Confirm-first with counts:** *"Pull 8 messages from main into this thread?"* /
  *"Push 3 new messages from #thread to main?"* (reuse `showConfirmModal`).
- **Nothing-new** → a `showToast` ("Nothing new to pull/push"), no empty block, no
  confirm.
- Owner/member access via the existing room access checks; mutations carry the
  `X-Webchat-CSRF` header.

## 8. Bounds & verbatim

- **Verbatim v1** — copies the actual messages. Bound the *fresh* pull to the last
  N (e.g. 50) or a time window so it can't dump an enormous backlog; incremental
  syncs are naturally small (just the delta).
- **Summary (later):** an optional "as summary" mode — one LLM turn condensing the
  delta into a single note — added per-direction afterwards. Push especially reads
  better as a condensed outcome. Out of scope for v1.

## 9. API

- `POST /api/rooms/:id/threads/:tid/pull`  → `{ copied: n }` (or `{ copied: 0 }`).
- `POST /api/rooms/:id/threads/:tid/push`  → `{ copied: n }`.
- Both update the relevant high-water mark, write copies + divider, seed the
  destination session, broadcast, and return the count for the toast/confirm.

## 10. Build phases (each ends green: typecheck + tests)

0. **Schema** — `origin` column + `webchat_thread_sync` table + idempotent
   migration; db helpers (get/advance marks, insert copies+divider, select deltas);
   cascade deletes. Unit-tested (delta selection, origin exclusion, no-op).
1. **Pull** — endpoint + copy + session backfill + broadcast. Tests: fresh pull
   bounded; incremental pull = delta; no-op when nothing new.
2. **Push** — endpoint + native-only delta + session backfill + broadcast. Tests:
   thread-own only (skip pulled prefix); multi-push = deltas, never duplicate;
   no-op.
3. **UI** — header controls (in-thread only), confirm-with-count, nothing-new
   toast, divider rendering.
4. **Docs** — CLAUDE.md threads section + this doc → "built".

## 11. Hook coordination / mergeability

Webchat-owned files (`src/channels/webchat/*`, `public/webchat/*`) are skill
`NEW_PATHS` — free to change. The `syncSessionContext` reuse touches
`src/session-manager.ts` (already webchat-hooked). The `webchat_messages.origin`
column is a webchat-owned migration (in `channels/webchat/migration.ts`), not a
central-DB one. No new core/trunk files are drawn into the hook surface; keep the
copy logic in the webchat module so the hook footprint stays unchanged. Publish
gate: `verify-webchat-publish.sh --full` green before publishing.
