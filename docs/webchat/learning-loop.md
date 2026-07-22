# The learning loop — how `/learn` works

Agents distill reusable skills from their own sessions. An agent that just
debugged something non-obvious can propose a `SKILL.md` capturing the lesson; a
human reviews it; if kept, it's wired to **that agent only**. Nothing the loop
produces ever runs without a human approving it first.

This is the *operator's guide to the shipped system*. The rationale and the
prior art (Hermes Agent's skill generation) live in the design doc:
[docs/webchat/design/learning-loop.md](design/learning-loop.md).

```
trigger (/learn · 🎓 · nudge)          human review                curator
        │                                   │                         │
        ▼                                   ▼                         ▼
 isolated review pass ──► staged draft ──► Keep ──► scoped skill ──► archive
 (digest, draft_skill      (never live)   /Discard  (this agent      when unused
  only)                                              only)           for 90 days
```

## 1. Triggering a review

Four surfaces, one code path — every trigger just sends `/learn`:

| Surface | Where | Notes |
|---|---|---|
| `/learn` | any channel | Trailing text steers the review: `/learn keep the rsync part even though it's well-known`. A leading URL or path makes it a source-directed review (§1a). In webchat it's in the slash menu. |
| 🎓 button | webchat composer, beside send | Always visible, enabled whenever the input is. |
| Nudge chip | above the composer | *"✨ Worth keeping? Distill a skill"* — appears only after a turn with **≥ 5 tool calls** (counted off the thinking-feed status events; no new wire data). Dismiss hides it until the next qualifying turn; switching rooms clears it. Suppressed in rooms where a wired agent has **auto-trigger on** — nudging a human to press the button the machine already presses is noise. |
| "Distill a skill…" | room settings → Skills | Same action, next to the room's proposals and learned skills. |

**Auto-trigger** (default **on**): the same busy-turn heuristic also fires the
review *itself* — at each turn's completion, inside the still-open query, with
an in-flight guard and a per-container cooldown (default 30 min). Auto reviews
are **silent on decline**; only a real draft announces itself (the in-room
card). It never uses the unrestricted fallback — no restricted pass, no auto
review. Toggle per agent from the 🎓 popover (admin tier: it spends tokens but
only ever *stages*).

**Adaptive cadence** (dry-streak backoff): every consecutive auto-review that
produces **no** proposal doubles the effective cooldown — 30 → 60 → 120 → 240
min, capped at **8×** the base. A room that is busy but unremarkable stops
paying for reviews it never keeps. Any proposal, or an explicit `/learn`,
resets the streak (a review that *errored* leaves it untouched). The state is
container-scoped, like the cooldown itself.

**Auto-keep** (default **off**, admin tier — same as the manual Keep it
automates): a staged draft is
applied immediately through the exact same code path as the human Keep — same
scoping, same update-before-create, same provenance. The one thing autonomy
removes is the wait. Turning it on means the agent accepts its own self-written
context unreviewed — which is why it ships off. A scoped admin can enable it
for their own agents: the blast radius equals what their manual Keep already
reaches.

The user's trailing text may override the reviewer's "too well-known to keep"
judgment, but never the denylist or the no-invention rule (below).

### 1a. Learning from a source (`/learn <url|path>`)

The hint after `/learn` can be a **source** instead of steering text — the
review then distills a skill from that source, not from the session:

```
/learn https://docs.example.com/guides/retries
/learn https://x.com/guide focus on the retry strategy   ← source + focus hint
/learn /workspace/project/scripts
/learn ./deploy just the rollout part
/learn ~/notes/backup-runbook.md
```

Detection is deliberately narrow: the hint must **start** with the source — a
`http(s)://` URL, or a path shape (`/…`, `./…`, `../…`, `~/…`, bare `~`/`.`).
Anything else — a bare filename, a URL mentioned mid-sentence — stays an
ordinary steering hint, byte-identical to plain `/learn`. Trailing words after
the source become a focus hint, passed alongside it.

The reviewer fetches or reads the source **itself**: URL mode adds `WebFetch`
to the restricted pass; path mode adds `Read`/`Glob`/`Grep` (bounded
exploration — top-level listing plus the load-bearing files). Still no shell,
no writes, no destinations — draft_skill remains the only way anything leaves
the review. A path the container can't reach simply fails in the review: the
agent says it can't read it, and stops.

**Source content is untrusted reference material.** The prompt instructs the
reviewer to never follow instructions found *inside* the page or files, never
copy secrets or credentials into the skill, and to describe the technique in
its own words — a procedure, not a mirror of the page's marketing copy. The
focus hint can steer what to keep, but never overrides those rules.

## 2. The review pass

`/learn` does **not** become an ordinary agent turn. On providers that support
it (Claude today — `supportsRestrictedReview` in the provider), the poll-loop
runs a **second, isolated query** at the idle point:

- **A digest, not a replay** (default): the runner keeps a bounded in-memory
  log of the session's recent exchanges (last 12 prompt/result pairs, ≤4k
  chars per field with head/tail truncation, ≤24k chars total). The review
  runs as a **fresh query** over that digest — nothing is replayed, so it
  costs a few thousand tokens instead of the whole transcript at main-model
  price. The main conversation is untouched by construction (there is no
  continuation to disturb). Set `learning.replayReview: true` to restore the
  old full-context behavior — a fork of the session (SDK `resume` +
  `forkSession`) with the entire transcript in context and the fork's
  continuation discarded. A fresh container with an empty exchange log (e.g.
  `/learn` as its first message) also falls back to the replay path.
- **One tool**: `allowedTools` drops to `mcp__nanoclaw__draft_skill`. No
  destinations, no a2a, no self-mod, no shell. The review can propose a skill
  and say one sentence; it can do nothing else. (Source-directed reviews —
  §1a — add only the read-only tools needed to reach the source.)
- **Optionally cheaper still**: set `learning.reviewModel` (per agent) or
  `NANOCLAW_LEARNING_MODEL` (container env; the config key wins) to run
  reviews on a smaller model than the turns that produced the exchanges.

Providers that can't restrict the toolset fall back to an in-turn review (the
authoring prompt replaces the message text; full toolset, main session). A
provider must not advertise `supportsRestrictedReview` without enforcing both
halves — advertising without enforcing would silently hand a "restricted"
review the full toolset.

### What the reviewer is told

The authoring prompt (in `container/agent-runner/src/mcp-tools/draft-skill.ts`)
carries the loop's quality rules:

- **The denylist** — never draft for: environment-specific failures (missing
  binaries), transient errors that resolved on their own, "tool X is broken"
  claims, or a diary of one task. Without this, every session produces a
  "skill".
- **"An empty answer is a good answer"** — a session that taught nothing is
  the normal case. The failure mode of a learning loop is inventing lessons to
  look useful.
- **Two trustworthy sources** — what the agent actually ran this session, and
  what the user explicitly stated or corrected (a user-stated lesson is ground
  truth). Nothing merely inferred; never invent flags, paths, or APIs.
- **Update before create** (next section).

The review's one-sentence outcome ("drafted X" / "nothing worth keeping")
always lands in the room that sent `/learn`. A failed review says so too
("nothing was lost — send /learn again in a bit") instead of dying silently.

## 3. Update before create

A loop that only ever *creates* fills the library with near-duplicates — the
same lesson re-learned and re-filed under a slightly different name. Two
mechanisms prevent that:

1. **The agent sees what it has.** The `draft_skill` tool description is built
   at container start from the skills actually mounted for the session (name +
   description), so the model matches against real names instead of being told
   to "prefer a patch" over skills it can't see.
2. **The hierarchy is enforced, not suggested** (`resolveDraftKind`):
   - a `create` whose name collides with an existing skill is **coerced into a
     patch** of that skill;
   - a `patch` at a target that doesn't exist is **rejected**, listing the real
     names.

One more dedup guard: staging a draft **supersedes any pending draft of the
same name on the same agent** (auto-trigger plus a manual `/learn` can both
stage the same lesson; the newer body reflects the later look at the session).

A patch carries the **complete revised SKILL.md** (not a fragment or a diff),
so applying it is a write to the target's path. Reviewers see a **line diff**
against the version it would replace. Patching a *pooled* skill forks it into
the agent's own scoped copy — the shared pool is untouched, other agents keep
the original. Provenance survives a revision: a refined `obra/superpowers`
skill is still theirs; only genuinely new skills get `origin: learned`.

## 4. Staging and review

A draft is **staged, never live**: the tool emits a `propose_skill` system
action; the host writes a row in `skill_drafts` (central DB) and the body under
`data/skill-drafts/<id>/SKILL.md`. Nothing reaches any agent until a human
acts.

Review surfaces (webchat):

| Surface | What |
|---|---|
| **In-room card** | Lands in the proposing agent's own room — name, description, `learned · <agent>` badge, **View / Keep / Discard**. Flips in place to `✅ … kept` / `🗑 … discarded`. |
| **Room settings → Skills** | The same proposals plus the agents' learned skills (removable) and archived ones (restorable). |
| **Skills page → Proposed skills** | The global list. Each draft links back to *"from this conversation →"* — the evidence behind the claim. |
| **⋯ menu badge** | A count of pending drafts on the overflow menu (dot on the button, number on the Skills item), so staged drafts aren't invisible until someone opens Skills. |

**View opens the draft in the SKILL.md editor — and drafts are editable.** A
new skill opens straight into editing; a revision opens on its **diff** with an
Edit/View-diff toggle (edits carry across the toggle). Save updates the draft;
Keep then applies exactly what you saved. Editing is admin-tier, same as Keep —
it shapes what gets kept. View works from every surface, including the in-room
card and room settings.

**Keep runs an overlap review first.** The draft is compared against the
agent's scoped skills, its *other pending drafts*, and the shared pool —
token-similarity always, plus a local-model judge through the LiteLLM router
when `NANOCLAW_OVERLAP_MODEL` is set in `.env` (e.g. `gemma4:latest`; free,
on-box). A hit shows *"Overlaps with X — keep anyway?"* with the reason;
the human can force through, **auto-keep cannot** — any detected overlap
degrades it to the normal staged flow. This catches the twins exact-name
dedup can't: the reviewer names skills freely, so the same lesson can arrive
as `branded-pdf-deliverables` today and `branded-pdf-documents` an hour later.

**Keep and Discard both arm a 10-second undo window** — the buttons swap for a
sliding countdown and an Undo; the action commits only when the bar empties.
The timer starts exclusively from a human click (auto-keep stays instant), and
a tab closed mid-countdown commits nothing — the draft stays pending, the safe
default.

**Expiry**: a pending draft self-discards only when BOTH hold — it's older
than 24 h, *and* its in-room card has scrolled out of the chat (≥30 newer
messages in the room; a draft with no card expires on age alone). A card still
in view stays actionable forever. Expiry discards only the draft; the worst
case of a wrong expiry is re-running `/learn`.

**Revision history**: applying a patch first snapshots the outgoing version
under `.history/<name>/<ts>/` in the same skills dir (dot-prefixed — skill
scanners skip it). A revised skill shows a **Revert** button in room settings;
revert restores the newest snapshot and snapshots the reverted-away version
first, so a revert is itself revertible — history only grows. This is the
recovery path for a bad revision under auto-keep.

**Keep** writes the skill into the agent's scoped dir
(`data/v2-sessions/<agent>/.claude-shared/skills/<name>/`), stamps
`.origin.json`, resolves the draft (row deleted, body removed), and restarts
that agent's containers so the next turn sees it. **Scoped means scoped**: a
learned skill never enters the shared pool, so there is no install-wide
fan-out. **Discard** deletes the draft.

## 5. The curator

A library that only grows rots. The curator ages **scoped** skills by *use*
and archives the stale ones. Pooled/shared skills are never touched — those
are operator-installed, and archiving something installed on purpose is not
curation.

- **Telemetry**: when the SDK's Skill tool loads a skill, the agent-runner
  stamps `.last-invoked` and increments a `.invocations` counter in that
  skill's dir (room settings shows *used N×*). (Pooled symlinks point into a
  read-only mount; their stamps fail and are skipped — correct, the curator
  doesn't manage them.)
- **The sweep**: rides the 60s host sweep, self-gated to one real run per day
  (marker at `data/learning/curator-last-run`). Age =
  `max(.last-invoked, SKILL.md mtime)` — *use beats age*, and a revision
  resets the clock. Past the threshold the skill **moves** to `.archive/`
  inside the same skills dir (dot-prefixed: every skill scanner skips it).
  **Nothing is ever deleted.**
- **Restore**: archived skills appear dimmed in room settings with a Restore
  button. Restore refuses to clobber a re-learned live skill of the same name,
  and stamps the restored skill as used — otherwise the next sweep would
  re-archive it a day later.

### Promotion: scoped → pool

When **two or more agents** have independently learned a skill of the same
name, the Skills page shows a *"Learned by several agents"* section. **Promote**
(owner/global-admin only — it's the one learning-loop write with install-wide
reach) copies the **newest** copy into the shared pool
(`data/user-skills/<name>/`) and moves each agent's own copy to its `.archive/`
— nothing is deleted, and every holder's containers restart to pick up the
pooled version.

## 6. Configuration

| Env var | Default | Meaning |
|---|---|---|
| `NANOCLAW_LEARNING_MODEL` | (turn model) | Model for the isolated review pass (`learning.reviewModel` wins over it). |
| `NANOCLAW_CURATOR_ARCHIVE_DAYS` | `90` | Archive a scoped skill unused this long. `0` or negative disables the curator. |

**Per-room first (the 🎓 popover):** the toggles you see in a room set THAT
ROOM's auto-distill and auto-keep (`learning_room_settings`, keyed by
messaging group; `GET|PUT /api/rooms/:id/learning`). One pair of switches per
room, however many agents are wired — the room layer overrides every wired
agent's default. Changing them requires admin over every wired agent and
restarts those agents' containers.

Per-agent defaults (stored in `container_configs.learning`, API-only:
`PUT /api/agents/:id/learning`) apply wherever a room has no override:

| Key | Default | Who can change it | Meaning |
|---|---|---|---|
| `autoTrigger` | `true` | room (🎓) or per-agent API | Busy turns (≥5 tools) auto-run the review. |
| `autoKeep` | `false` | room (🎓) or per-agent API | Apply drafts immediately, no human review. |
| `cooldownMinutes` | `30` | per-agent admin (API only) | Minimum gap between auto reviews per container. Dry reviews stretch it (backoff, §1) up to 8×. |
| `reviewModel` | (turn model) | per-agent admin (API only) | Model for the review pass. Wins over `NANOCLAW_LEARNING_MODEL`. |
| `replayReview` | `false` | per-agent admin (API only) | Escape hatch: review on a full-transcript session fork instead of the bounded exchange digest. Costlier, maximally informed. |

## 7. Where things live

| What | Where |
|---|---|
| Draft rows | `skill_drafts` (central DB, migration `learning-skill-drafts`) |
| Draft bodies | `data/skill-drafts/<id>/SKILL.md` |
| Scoped skills | `data/v2-sessions/<agent>/.claude-shared/skills/<name>/` |
| Archived skills | `…/skills/.archive/<name>/` |
| Use telemetry | `…/skills/<name>/.last-invoked`, `…/.invocations` |
| Revision history | `…/skills/.history/<name>/<ts>/` |
| Curator marker | `data/learning/curator-last-run` |
| Tool + authoring prompt | `container/agent-runner/src/mcp-tools/draft-skill.ts` |
| `/learn` handling + review pass | `container/agent-runner/src/poll-loop.ts` |
| Restricted/forked query | `container/agent-runner/src/providers/claude.ts` |
| Staging handler + events | `src/modules/learning/` |
| Curator | `src/modules/learning/curator.ts` (hooked from `src/host-sweep.ts`) |
| Draft/keep/restore API + UI | `src/channels/webchat/server.ts`, `public/webchat/app.js` |

## 8. Security properties

- **Staged, not live** — nothing runs until an owner/admin keeps it.
- **Scoped by default** — a kept skill lands on the learning agent only.
- **The review can't act** — draft_skill is its only tool; it runs on a
  bounded digest (or a discarded fork in replay mode) and can't touch the
  main conversation.
- **Gated cost** — no tokens spent unless a human triggers a review (the nudge
  is a suggestion, not a trigger).
- **Provenance-badged** — `learned` skills stay visually distinct from vetted
  imports everywhere badges render, including the topology graph.
- **Reversible** — discards delete only the draft; the curator archives and
  never deletes; restores never clobber.
