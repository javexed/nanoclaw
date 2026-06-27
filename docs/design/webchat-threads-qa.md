# Per-room threads — QA script

Interactive checklist for `feat/webchat-threads` (PR #72). The backend is
unit-tested (278 pass); this validates the **slice-4 UI**, which can't be
unit-tested. Run on a **dev/throwaway instance**, not the live install.

## Setup
- Pull `feat/webchat-threads`, `pnpm install && pnpm run build`, `./container/build.sh`, restart the host. Open the webchat PWA.
- Have a room wired to **two agents** (Sarah + Max) for the auto-spawn checks, and one room with a **single agent** for the no-regression check. Be signed in as **owner** (delete is owner-only).

## 1. No regression (thread-less room)
1. Open the single-agent room. Send a message; get a reply.
   - ✓ Works exactly as before. Sidebar shows the room with a `# main` thread under it. The agent remembers prior context (same session as before — no reset).

## 2. Create + switch + isolation
1. In the multi-agent room, click **+ thread**, name it `Trip planning`.
   - ✓ A `# Trip planning` row appears under the room; the view opens it (empty).
2. Send "plan a 3-day trip to Lisbon"; wait for the reply.
   - ✓ Reply renders in this thread.
3. Click `# main`.
   - ✓ View switches to main's history; the Trip planning messages are **not** shown.
4. Back in `Trip planning`, ask "what city was that again?".
   - ✓ The agent answers Lisbon (thread has its own context).
5. In `main`, ask "what city were we planning for?".
   - ✓ The agent does **not** know (separate session — this is the point of threads).

## 3. Reply routing + per-thread unread
1. Open `main`. Have someone (or another browser/device) send into `Trip planning`, or trigger an agent reply there while you're viewing `main`.
   - ✓ A small **unread dot** appears on the `Trip planning` row; the message does **not** appear in your main view.
2. Click `Trip planning`.
   - ✓ The dot clears; the new message is there.

## 4. Rename + delete (owner)
1. Hover a non-main thread → kebab (⋯) → **Rename** → new name.
   - ✓ The row title updates.
2. Kebab → **Delete** → confirm.
   - ✓ The thread disappears; if it was open, you land back on `main`. Its messages are gone.
   - ✓ `# main` has **no** kebab (can't be renamed/deleted).
3. (Non-owner) Sign in as a non-owner member.
   - ✓ Create/rename are available; **Delete is absent**. (Server also rejects a forced delete with 403.)

## 5. Auto-spawn (confirm-first, multi-agent room)
1. In `main` of the Sarah+Max room, send "@sarah draft the roadmap".
   - ✓ Message posts to main, AND a banner appears above the composer: **"Continue with @Sarah in its own thread?"** with **Open thread / Dismiss**.
2. Click **Open thread**.
   - ✓ A `@ Sarah` lane opens; continue chatting there (its first stored message registers the lane in the tree).
3. Back in `main`, send "@sarah @max reconcile the numbers" (two mentions).
   - ✓ **No** banner — stays in main, both agents engage.
4. Send "what's the status?" (no mention).
   - ✓ **No** banner.
5. Room settings → turn **auto-thread off** → send a single-mention again.
   - ✓ **No** banner.
6. In the **single-agent** room, single-mention the agent.
   - ✓ **No** banner (auto-spawn never fires for single-agent/DMs).

## 6. Persistence / reconnect
1. Open a thread, reload the page.
   - ✓ The room reopens on the **same thread** (per-room last-open thread is remembered).
2. Kill + restore network (or restart the host) while a thread is open.
   - ✓ On reconnect, the open thread's history is intact and new messages still route correctly.

## Known v1 limits — confirm these are acceptable, not bugs
- Only the **active room's** thread tree is shown (no per-room expand/collapse of other rooms' threads yet).
- The single-mention message that triggers a suggestion **stays in main**; the conversation continues in the lane (confirm-first-after-send).
- Rapid thread switching has **no history-race guard** — switching very fast could briefly show the prior thread's history before the new one loads.

## Pass criteria
Sections 1–6 behave as described, and the §"known limits" items match expectations. Anything else (especially: a thread click that re-opens the room instead of switching, messages leaking across threads, or the agent showing cross-thread memory) is a bug — capture the steps.
