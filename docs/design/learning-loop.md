# Learning loop — design

> **Built.** This is the design rationale; the operator guide to the shipped
> system is [docs/learning-loop.md](../learning-loop.md).

*Proposed design (not yet built) for auto-generating skills from experience.
The premise, validated by reading Nous Research's Hermes Agent
([`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent)):
skill generation is not an ML pipeline — it's **"run the agent on its own
transcript with a skill-authoring prompt and a restricted toolset."** nanoclaw
already has every primitive except the review pass and a draft-review surface,
so this reuses the shipped skills stack ([skills.md](skills.md)) wholesale.*

**Guiding principle:** drafts are staged, not live; approved skills default to
the ONE agent that learned them (no install-wide fan-out — consistent with the
skills security review); the review is gated + cheap-model so it costs nothing
unless a real signal fires or you ask.

## The loop

```
 session turn ends (poll-loop drains messages_in, nothing pending)
        │
        ▼
 [1] TRIGGER gate ── turn signals (tool-count, error→resolve, user correction)
        │            + explicit /learn → decide: run a review?
        ▼
 [2] REVIEW PASS  ── agent-runner runs a SECOND provider query with a RESTRICTED
        │            toolset (only `draft_skill`), reads the transcript, applies
        │            the authoring prompt + denylist + prefer-edit hierarchy
        ▼
 [3] DRAFT emitted as a `propose_skill` system action → outbound.db
        │            (same channel as schedule / approvals)
        ▼  host: src/delivery.ts
 [4] HOST stages it → skill_drafts row + data/skill-drafts/<id>/SKILL.md  (never live)
        │
        ▼
 [5] WEBCHAT "Proposed skills" → preview in the SKILL.md editor → Keep & wire
        │            (scoped to THIS agent) / Wire to all / Discard
        ▼
    approved → data/v2-sessions/<group>/.claude-shared/skills/<name>/  (live next spawn)
```

| Stage | New code | Reused primitive |
|-------|----------|------------------|
| Trigger + review hook | `container/agent-runner/src/poll-loop.ts` | the poll loop's idle/drain point |
| `draft_skill` tool | `container/agent-runner/src/mcp-tools/draft-skill.ts` | MCP tool interface + toolset gating (`cli_scope` pattern) |
| Draft → host | `propose_skill` handler in `src/delivery.ts` | outbound.db system-action channel (schedule/approvals) |
| Staging store | `skill_drafts` table + `data/skill-drafts/` | central DB + migrations |
| Review UI | `src/channels/webchat/server.ts` + `public/webchat/` | the SKILL.md editor + "Proposed skills" surface |
| Keep & wire | — | the per-agent scoped wiring + attach picker (`openWireToAgentsPicker`) |
| Provenance | — | `.origin.json` sidecar → `origin: "learned"` badge |
| Curator (v2) | `src/host-sweep.ts` job | the 60s host sweep |

## 1. Trigger

The agent-runner sees the whole turn, so it collects cheap signals as it runs:
tool-call count ≥ N, an error observed then a later success, a user correction
("no, do X instead"), session length.

**Decision: explicit-first, heuristic-gated, classifier-later.** Hermes' trigger
is a bare heuristic ("5+ tool calls") — nanoclaw can do better:

- **v1 explicit** (reliable, zero false positives): a `/learn` message and a
  webchat **"Distill a skill from this session"** button. No guessing.
- **v1 heuristic** (opt-in): the signal thresholds above fire a review.
- **v2 classifier**: route a heuristic hit through a cheap/local model that
  answers "is there a reusable, non-obvious procedure here?" — this is where
  nanoclaw beats Hermes, whose gate never judges *quality*.

Per-agent opt-in: `container_configs.learning = { enabled, trigger, model }`,
default conservative (explicit-only) so it never surprise-costs the operator.

## 2. The review pass

Runs **in the same container** at the poll-loop idle point — transcript already
in hand, no cold start — as a second provider query. This is Hermes'
`spawn_background_review` (a forked in-process agent), expressed with nanoclaw's
toolset gating instead of their `_persist_disabled` / `_session_db=None` flags.

- **Restricted toolset** — only `draft_skill`. No destinations, no a2a, no
  self-mod, no `ncl` writes. The review can read the transcript and propose a
  skill; it can do nothing else. (Reuse the `cli_scope`/toolset-restriction
  mechanism.)
- **Cheaper model** — `learning.model` may be smaller than the turn model, like
  Hermes' `auxiliary.background_review.model`.
- **Authoring prompt** — copy Hermes' proven shape: front-matter (`name`,
  one-line `description` per [DESIGN.md](../../public/webchat/DESIGN.md)'s prose
  budget, `version`), a fixed section order (When to use → Prerequisites →
  Procedure → Pitfalls → Verification), and **"never invent flags, paths, or
  APIs."**

**The two quality-critical bits, copied verbatim from Hermes' `_SKILL_REVIEW_PROMPT`:**

- **Denylist — what NOT to learn:** environment-dependent failures ("command not
  found", missing binaries), transient errors that resolved mid-session, "X tool
  is broken" claims, one-off task narratives. Without this the library fills with
  noise.
- **Prefer-edit hierarchy:** the prompt is shown this agent's existing skills
  (scoped + shared) and instructed — *update a currently-loaded skill → update an
  existing umbrella → add a support file under one → only then create new.* Kills
  skill sprawl. An edit is emitted as a **patch draft**, not a rewrite.

## 3–4. Draft → host (staging, never live)

`draft_skill` writes a **`propose_skill` system action into `outbound.db`** — the
same mechanism `schedule` and `approvals` already use (see
[delivery.ts](../../src/delivery.ts)). The host's delivery poll materializes it
into a **`skill_drafts`** row plus `data/skill-drafts/<id>/SKILL.md`. Nothing is
mounted into any agent until approved — this is Hermes'
`~/.hermes/pending/skills/` + `/skills approve`, mapped onto nanoclaw's approval
model.

## 5. The review surface

A **"Proposed skills"** section in the webchat Skills UI (count badge, like the
update banner):

- Open a draft → the **SKILL.md editor** (preview + edit before accepting).
- **Keep & wire** → routes through the **per-agent scoped path** — defaults to
  the ONE agent that learned it (no fan-out), with the "Wire to all agents"
  option from the attach picker; or **Discard**.
- Learned skills carry **`origin: "learned"`** in `.origin.json` → a distinct
  coloured provenance badge, so an auto-generated skill is never mistaken for a
  vetted import.
- A patch draft renders as "Proposed change to `<skill>`"; approving applies the
  patch to the existing SKILL.md.

## 6. Curator (v2, optional)

A `host-sweep` job (nanoclaw's 60s sweep, or a daily timer): mark scoped skills
stale/archived by last-invoked timestamp (30/90 days → an `.archive/` dir), never
delete. Optional LLM consolidation of prefix-clusters into umbrellas later. This
is Hermes' curator (`agent/curator.py`) on nanoclaw's sweep rather than their
idle-at-startup trigger. Needs last-invoked telemetry: the agent-runner logs
skill loads to outbound.

## Data model

| Change | Where |
|--------|-------|
| `skill_drafts` (id, agent_group_id, session_id, kind `create`\|`patch`, target_skill, status, created_at) | central DB + migration |
| `container_configs.learning` (enabled, trigger, model) | `src/db/container-configs.ts` + migration |
| `propose_skill` system action | agent-runner MCP tool + `src/delivery.ts` handler |
| `origin: "learned"` | reuse `.origin.json` — no schema change |
| last-invoked telemetry (v2) | agent-runner → outbound |

## Safety, cost, security

- **Staged, not live** — nothing runs until an owner/admin approves (same gate
  as skill writes, which the security review restricted to owner/global-admin).
- **Scoped by default** — approved skills land on the learning agent only, never
  the shared pool → no install-wide fan-out.
- **Gated + cheap** — no token cost unless a real signal fires or the operator
  asks; the review can use a smaller model than the turn.
- **Provenance-badged** — `origin: "learned"` keeps auto-generated skills
  visually distinct from vetted imports everywhere the badge renders.

## Phasing

- **MVP** — explicit `/learn` + webchat "Distill a skill" → review pass
  (restricted toolset, authoring prompt + denylist + prefer-edit) → staged draft
  → "Proposed skills" → Keep & wire (scoped). The only genuinely new code is the
  `draft_skill` tool, the `skill_drafts` table + `propose_skill` handler, and the
  review UI — everything else is shipped plumbing.
- **v2** — heuristic/classifier auto-trigger, patch-existing drafts, the curator
  sweep with last-invoked telemetry.

## Prior art

Grounded in a code-level read of Hermes Agent (Nous Research, MIT). What we
adopt: the fork-and-review architecture, the `/learn` authoring spec, the
denylist, and the prefer-edit hierarchy. What we deliberately diverge on:
nanoclaw stages to a **review surface** and defaults to **scoped** (Hermes can
write scoped-per-agent too but pools by default), gates the trigger on an
optional **classifier** rather than a bare tool-count, and runs the curator on
the **host sweep**. What Hermes markets but isn't in their code — per-skill
success-rate tracking, auto version-bumping, a "cron" curator (it's actually
idle/interval-triggered) — we skip; if we want success stats, we add them
deliberately.
