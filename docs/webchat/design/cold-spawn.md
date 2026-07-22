# Cold-spawn time-to-first-token

Measure-first pass over the cold path: user message → router → session resolve
→ `spawnContainer` → container boot (bun) → first poll → provider init (Claude
Code SDK subprocess) → first provider token. All numbers measured on the live
Linux install (Docker, warm service, 2026-07), via live `nanoclaw.log` +
session-DB timestamps and offline container harnesses against the real agent
image and a copy of a real group's `.claude-shared`.

## Cost table

| # | Step | Measured | Critical path? | Optimization candidate? |
|---|------|----------|----------------|-------------------------|
| 1 | Router → spawn prep (writeDestinations, session routing, `materializeContainerJson`, `initGroupFilesystem`, skill-symlink sync, CLAUDE.md compose, prepare hooks) | 40–280 ms total for #1+#2 (log delta "Message routed" → "OneCLI gateway applied": 37/70/98/281 ms) | yes | no — local fs/SQLite, already marker-gated (`initGroupFilesystem` is existsSync-gated per step) |
| 2 | OneCLI `ensureAgent` + `applyContainerConfig` (2 HTTP calls to the gateway) | inside the same 40–280 ms; bare gateway GET is ~75 ms | yes | marginal — see "Deferred" |
| 3 | `docker run` → container process up | 500–750 ms warm | yes | no cheap lever (no `--pull` cost; flags already minimal); container pool deferred |
| 4 | bun boot | ~270 ms | yes | image-level; warmed by #W |
| 5 | agent-runner import chain (providers barrel incl. SDK esm, poll-loop, mcp deps) | 220–290 ms + ~90 ms warm | yes | **implemented** — persistent bun transpiler cache: 221→94 ms measured |
| 6 | runner init → first poll `start` event | live total spawn→`start` = **740 ms** (covers #3–#6) | yes | already minimal (first poll is immediate; `isFirstPoll` path) |
| 7 | provider `query()` → SDK `init` (Claude Code native binary exec, settings + ~12 skills scan, SessionStart memory hook, nanoclaw MCP handshake) | 840–1900 ms warm; 2.6–8.7 s cold-cache/loaded (one 23 s outlier under CPU contention) | yes | cold-cache half **implemented** via warmer; warm floor is the CLI's own startup |
| 8 | — of which nanoclaw MCP handshake | ~100–150 ms | yes | no — core tool surface, not worth lazy-loading |
| 9 | — of which SessionStart memory hook | ~5 ms | yes | no |
| 10 | Transcript resume | ~0 at 300 KB; grows with `.jsonl` size | yes (resumed sessions) | already handled — `maybeRotateContinuation` caps at 12 MB / 14 d |
| 11 | First API request → first token (prefill + model) | seconds to tens of seconds (a live Opus hub turn: `start`→first tool = 76 s, dominated by long-context prefill + thinking) | yes | not code-controllable; webchat thinking bubble already covers perceived latency |

Total code-controlled overhead on a warm host: **~1.6–2.9 s** (steps 1–7).
The Hermes-style fat (repeated probes, non-incremental scaffolds, pull checks)
mostly was not present: group-init is already idempotent-by-marker, there is no
`--pull` on the spawn path, and the OneCLI round-trips are ~100–200 ms combined.
The two real, measured levers were the cold page cache and the bun transpiler
re-parse — both addressed below.

## Implemented

### 1. Startup image warmer (`src/container-warm.ts`, called from `src/index.ts`)

The dominant *variable* cost is the host page cache. Overlayfs layers are
ordinary host files, so the cache is shared across all containers of an image
— but the first spawn after a host restart or image rebuild pays the whole
cold-disk bill on the user's message:

| Path | cold | warm |
|------|------|------|
| `claude --version` in-image (native binary fault-in) | 1.80 s | 0.10 s |
| SDK `query()` → `init` | 2.6–8.7 s | 0.8–1.9 s |
| bare `docker run … true` | 0.75 s | 0.51 s |

The warmer is one fire-and-forget throwaway container at service start
(`--network none`, `--memory 1g`, `--rm`, install-labeled so `cleanupOrphans`
reaps a straggler). It imports the same agent-runner module graph a real spawn
imports and execs `claude --version`, faulting in exactly the pages the first
turn needs. Measured warm-run cost: **0.7 s, off the critical path**; expected
first-message saving after a restart/rebuild: **~2–7 s**. Per-group images are
`FROM` the base image, so warming the base warms their shared heavy layers too.

### 2. Persistent bun transpiler cache (one `-e` in `buildContainerArgs`)

Bun's runtime transpiler cache (files ≥ 50 KB — the SDK's `sdk.mjs`/
`bridge.mjs` qualify) defaults to the container's ephemeral tmpdir, so every
cold spawn re-parses. Pointing `BUN_RUNTIME_TRANSPILER_CACHE_PATH` at
`/home/node/.claude/.bun-transpiler-cache` (the per-group `.claude-shared`
RW mount) persists it across spawns of the same group:

- providers-barrel import: 221–244 ms → 94–160 ms (**~130 ms saved**, more on a
  cold host); also caches the nanoclaw MCP server's bun boot inside step 7.
- Per-group dir, same trust domain as the rest of `.claude-shared`; when the
  mount is absent (surface-providing providers) the path is an in-container
  dir and behavior is unchanged.

## Measured dead ends (do not retry without new evidence)

- **`NODE_COMPILE_CACHE` for the CLI subprocess** — `/pnpm/claude` execs
  `claude.exe`, a native compiled binary (Claude Code ≥ 2.x). There is no JS
  parse/compile to cache; the env var produces no cache dir and no effect.
- **Overlapping provider init with the first inbound read** — the first poll
  runs immediately on boot (`isFirstPoll`), so the gap between provider
  construction and the first `query()` is ~0 ms. A "warm query" pre-spawn has
  nothing to overlap with.
- **Skipping/lazying the nanoclaw MCP server** — the handshake costs
  ~100–150 ms of step 7 and is the agent's core tool surface.
- **group-init incrementality** — already incremental; every step is gated on
  the target existing (verified, no change needed).

## Deferred (written up, not implemented)

- **`ensureAgent` marker cache** (skip the ensure round-trip when the agent id
  was ensured within N hours): saves under ~150 ms of a ≤ 280 ms host-prep
  step, and introduces a real failure mode — an OneCLI agent deleted
  externally would skip re-creation and turn every spawn into a gateway
  refusal loop until the marker expires. The correct shape (invalidate the
  marker when `applyContainerConfig` fails, retry the ensure once) is more
  code than the win justifies at current numbers. Revisit only if the gateway
  round-trip cost grows (e.g. remote gateway).
- **Pre-created container pool** (`docker create` ahead of demand, `start` on
  wake): would cut step 3's ~0.5–0.75 s but conflicts with per-spawn mount
  args (session dir is chosen at wake time), complicates `cleanupOrphans` /
  `--rm` semantics, and is upstream-shaped surgery in `container-runner.ts`.
  Not justified while step 3 is < 15 % of the warm total.
- **Warming after per-group image rebuilds** (`buildAgentGroupImage`,
  self-mod apply): the base-layer warm at service start covers the shared
  heavy layers; a per-rebuild warm would only fault in the group's extra
  apt/npm layers. Add a `warmAgentImage()`-style call at the end of the
  rebuild path if rebuild-then-first-message latency ever shows up in
  practice.

## Non-goals honored

Container security flags, session-DB pragmas (`journal_mode=DELETE` is
load-bearing), and `on_wake` semantics are untouched.
