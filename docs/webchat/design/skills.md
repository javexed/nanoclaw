# Skills — design and architecture

*As-built reference for the webchat skills feature (PR #190 lineage). Skills
are standard [Anthropic Agent Skills](https://github.com/anthropics/skills): a
folder with a `SKILL.md` (front-matter `name` + `description`, then
instructions, optionally scripts), loaded by the Claude Agent SDK from
`.claude/skills/`.*

## The two-mount model

| Mount | Host path | Container path | Contents |
|-------|-----------|----------------|----------|
| Shipped | `container/skills/` | `/app/skills` (RO) | version-controlled, ship with the repo |
| User | `data/user-skills/` | `/app/user-skills` (RO) | imported / written at runtime; **gitignored** |

**Decision: no baking.** Adding a skill never rebuilds the image and never
commits to the repo — `data/user-skills/` is a bind-mount, so a new skill is
available to the next session. "Get Anthropic's official skills" is therefore
an *import*, not a curation step in the repo.

Resolution (`container-runner.ts`): `availableSkillNames()` unions both mounts;
`skillContainerTarget()` picks the mount per skill — **shipped wins on a name
collision** (a user skill can't shadow a builtin). `syncSkillSymlinks()` runs at
spawn and repairs symlinks whose target mount changed.

## Per-agent assignment

`container_configs.skills` is `'all' | string[]`.

- `'all'` (default) resolves at spawn to *everything in both mounts* — so
  imports fan out to every `'all'` agent automatically. This is deliberate
  (zero-setup default) but is also the main thing to know: **importing a skill
  gives it to every default-configured agent.**
- The webchat agent-detail Skills panel writes an explicit list
  (`PUT /api/agents/:id/skills`) and respawns the agent. Once explicit, new
  imports need a manual toggle-on.

Cost of an enabled-but-unused skill: its name+description in context each turn
(~40–70 tokens); the SKILL.md body loads only on invocation.

## Import pipeline (`POST /api/skills/import`)

GitHub folder URLs only (`github.com/OWNER/REPO/tree/BRANCH/DIR`) — a
deliberate SSRF stance: the contents API + `download_url`s only reach GitHub
hosts. Caps: 60 files / 8MB. The tree walk is serial (each level needs its
parent listing); file downloads are parallel (54-file `xlsx`: ~10s serial →
~4s). Files stage into `<dest>.importing` and swap in atomically, so a failed
fetch can't leave a half-written skill. A `SKILL.md` at the folder root is
required.

### Provenance (`.origin.json` sidecar)

Every import records where the skill came from in a `.origin.json` sidecar
inside the skill folder — `{ label, url?, official? }` — so the installed list
can badge each skill with its origin ("Anthropic", "obra/superpowers",
"awesomeskill.ai", "custom") long after import, when it's otherwise invisible.
The same `originBadgeEl()` renders the badge everywhere — installed list and the
Add-view pool — as a **clickable link** to the source. Official is a fixed green;
every other collection gets its **own stable colour** from a hue hashed off its
label (`labelHue`), theme-aware lightness so it stays legible — so a newly added
collection is visually distinct for free.

**Decision: sidecar, not front-matter.** Provenance is metadata about the
import, not about the skill's behavior — keeping it out of the agent-facing
`SKILL.md` means editing the skill never disturbs it, and it self-cleans when
the folder is deleted. `label` is what the client passed (the catalog collection
it was added from, or the marketplace it was discovered via); if absent it falls
back to the git `owner/repo` parsed from the fetch URL — **the label is display
trust, the URL-derived owner/repo is real trust and can't be spoofed.**
`official` is only set for the Anthropic tier (green badge); everything else is
dim. Hand-authored skills (the editor's "Write your own") stamp `label: custom`,
written only when no origin exists so an imported skill's provenance survives
edits. Legacy user skills with no sidecar badge as "imported".

## Catalog sources (`webchat_skill_sources`, migration 120)

The "well-known collections" browsable from the Skills tab. DB-backed and
editable from Settings (global-admin writes; server verifies a new source
actually lists skill folders before saving). Seeded:

| id | Repo | `official` | Why |
|----|------|-----------|-----|
| `anthropic` | `anthropics/skills` (`skills/`) | `1` | first-party, 17 skills |
| `superpowers` | `obra/superpowers` (`skills/`) | `0` | best-known community collection |

`loadCatalog` **walks the repo's git tree recursively** (one API call) and takes
every folder that contains a `SKILL.md` at any depth under `dir` (empty dir =
whole repo). So a collection can be a repo root, a single folder, or skills
nested under category folders (e.g. `letta-ai/skills` → `letta/*`, `meta/*`,
`tools/*`, 45 skills) — not just one flat directory. Leaf-name collisions dedup
first-wins; capped at 100 skills/collection to bound the per-skill description
fetches (`raw.githubusercontent.com`, not API-rate-limited). Cached 1h in-memory,
stale-served on fetch errors, invalidated on source edit.

**Adding a collection takes only a URL** — no label field. `resolveSourceUrl`
accepts a folder URL (`…/tree/branch/dir`), a branch URL, or a **bare repo root**
(`github.com/owner/repo` → default branch via one API call, whole repo). The
server names it after what it pulls in (`owner/repo`, so the Settings row and the
pool badge match); the id derives from `owner-repo[-dir]`.

The Settings list renders each collection's coloured origin badge (same as the
pool). Below the editable GitHub collections it shows the **built-in
marketplace** (`awesomeskill.ai`) — code-wired (`builtins` in the
`/api/skills/sources` response, not a DB row), so nothing to edit, but
**removable**: a reversible toggle (`DELETE`/`PUT` on its id) persisted in
`webchat_disabled_sources` (migration 122). Disabled → the marketplace drops out
of the Community pool; the row stays listed (dimmed) with an **Add** button to
switch it back on, since there's no URL to re-paste.

### Two-tier trust (`official`, migration 121)

**Decision: trust is a deliberate top-level mode, not an emergent property of
the source dropdown.** The Add view leads with an Official / Community segmented
control (reusing `.agent-subtab`). Only `official = 1` sources (Anthropic today,
and any future first-party set) are "official": direct Add, no warning, no
Review link, no confirm. Everything else — Superpowers and every admin-added
collection (`upsertSkillSource` always writes `official = 0`) — is Community: a
**persistent** unreviewed banner (a property of the tier, so it never flickers),
a per-skill Review-on-GitHub link, and a confirm gate before import.

Why a segment and not the old mixed dropdown: flipping a dropdown that
interleaved official and community sources silently mutated the trust chrome
(banner/Review/confirm appearing and vanishing) — trust ambushed the user
mid-scroll instead of being chosen.

### One merged pool per tier (`GET /api/skills/catalog?tier=&q=`)

**Decision: within a tier there is no source picker — one merged, deduped pool.**
`catalogPoolHandler` loads every GitHub collection in the tier *and* (community
only) the awesomeskill.ai marketplace, tags each skill with its `origin`, dedups
by sanitized name (curated collections listed first so they win over marketplace
copies of the same skill), and sorts by name so sources **interleave** — no
collection is grouped or shown first. A `q` filters the GitHub collections by
substring and searches the marketplace; the one search box filters the whole
pool. Each row's colored, clickable origin badge (see Provenance) carries and
links to its source, so the old per-source dropdown and marketplace credit line
are both gone. A dead source or marketplace outage is swallowed per-source so it
can't blank the pool. The pool refetches on every tab switch / keystroke (no
client cache), so an admin-added collection appears immediately.

## Suggestions (`GET /api/skills/suggest`)

At agent-create time, the form's text (description/name/instructions) is scored
against installed skills + all catalog entries. **Decision: deterministic
keyword+synonym scoring, no LLM** — the form calls it per keystroke (debounced),
so it must be instant and work on installs with no local model. Name-token and
synonym hits score 3, description tokens 1; threshold 3, top 5. The synonym map
(`SKILL_SYNONYMS`) bridges phrasing gaps ("spreadsheet" → `xlsx`) and is the
tuning knob. Installed matches render as "available" (informational — `'all'`
agents already get them); catalog matches get a checkbox and import on Create.

## Editor (`GET/PUT /api/skills/:name`)

User skills are editable in the UI (and directly on disk at
`data/user-skills/<name>/`); **shipped skills are read-only** — they're repo
files; copy into a new name to fork one. PUT requires front-matter with a
description (so the picker never fills with blanks), caps at 512KB, and only
writes `SKILL.md` — extra files come via import or the host filesystem.

## Per-agent (scoped) skills

**Decision: a skill can be wired to ONE agent group without entering the shared
pool.** The shared `data/user-skills` pool fans out to every `'all'` agent
(the default), so a pooled import lands on all of them — the fan-out the security
review flagged. A *scoped* skill instead lives as a **real directory** in the
target group's own `.claude-shared/skills/<name>/`, which mounts at
`~/.claude/skills` — so only that group loads it, and `'all'` never includes it
(`availableSkillNames()` only scans the pool, not per-group dirs).

`syncSkillSymlinks` manages *symlinks* (the pooled fan-out) and leaves real dirs
untouched, so a scoped skill coexists with the `'all'` symlinks in the same dir;
`listScopedSkills()` distinguishes them with `lstat` (real dir = scoped, symlink
= pooled). Endpoints hang off the agent, not the global skills surface:
`POST /api/agents/:id/skills/import` (repo/folder/repo-root URL → staged into the
group dir → `restartAgentGroupContainers`) and `DELETE …/skills/scoped/:name`.
Both are gated `hasAdminPrivilege(agent)` — a scoped skill can't affect any other
group, so per-group admin is sufficient (and it sidesteps the pooled-import
escalation entirely). Surfaced in the agent's Skills panel under "Wired to this
agent", above the shared-pool checkboxes.

## Gating

| Surface | Client | Server |
|---------|--------|--------|
| List / import / edit / delete POOLED skills | admin (`isAdminView`) | owner/`isGlobalAdmin` for writes (install-wide fan-out) |
| Assign a pooled skill to an agent | agent detail | `hasAdminPrivilege(agent)` |
| Import / remove a SCOPED skill (one agent) | agent detail | `hasAdminPrivilege(agent)` — affects only that group |
| Catalog source add/edit/remove | owner view (Settings) | `isGlobalAdmin` — install-wide trust decision |

## Dependency stance

Skills with script dependencies (the document skills' Python libs) are **not**
pre-baked. Options, in order: let the agent self-install on first use into a
persisted path; or, if a dep-heavy skill becomes load-bearing, add its libs to
the container image once (one rebuild covers every skill sharing them).

## Marketplace (awesomeskill.ai)

The awesomeskill.ai marketplace is a community source **pooled into the Community
tier** (not a separate view). `fetchMarketplace(q)` proxies the call host-side
(browser stays out; awesomeskill.ai is the ONE allowlisted discovery host,
separate from the GitHub-locked importer). Empty `q` = browse top-by-stars (the
default community pool); a query searches. It's best-effort — an error returns
`[]` so a marketplace outage can't blank the pool. Results normalize to
`{name, title, description, repo, stars, reviewUrl}`; each is badged
`awesomeskill.ai` and gated behind the same review confirm as every community
skill.

**Trust is structural, not decorative** — the marketplace pulls unvetted code
that will run in agents: the persistent Community warning banner, a per-row
**Review ↗** link to the repo, a **destructive confirm** naming the source on
import, and the existing "imported but inert until assigned" final checkpoint.

The marketplace returns a repo root, not a folder path — so import sends
`{repo, name}` and `resolveDiscoveredSkillUrl` walks the repo's git tree once to
find the `SKILL.md` whose parent dir matches the name, then hands the folder URL
to the normal importer. Can't pinpoint it → a 422 that says "import the folder
URL by hand" (the Review link). All GitHub calls go through `githubFetch`, which
retries once on a 5xx (their gateway throws transient 502s under load).
