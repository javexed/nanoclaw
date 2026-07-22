# Upstream drift audit — 2026-07 reduction pass

Audit of every file that **exists on `origin/main` (nanocoai/nanoclaw) and differs
on this branch**, per the fork rule: the fork never merges upstream; upstream-origin
files should be byte-identical to `origin/main` wherever possible, with webchat
layering on via the overlay (`install-webchat.sh` NEW_PATHS wholesale copies +
HOOK_FILES reversible 3-way patches).

Snapshot: branch `chore/upstream-drift-reduction` (from `channels-webchat`),
fork point `0b034342`, upstream tip `641963c1`. 100 upstream-origin files diverged.
Only **one** of them diverged upstream-side since the fork point
(`docs/BRANCH-FORK-MAINTENANCE.md`); the other 99 are fork edits.

## Categories

- **R — restored**: byte-identical to `origin/main` again (obsolete/cosmetic fork delta).
- **H — hookified**: moved onto the designed overlay mechanism (HOOK_FILES + blessed allowlist).
- **K — kept**: load-bearing fork delta; delivered/explained via HOOK_FILES, an installer
  step, or a documented publish-gate coverage class.

Publish-gate result of this pass: **orphans 17 → 4 fixed structurally + 13 covered**
(see the final section) — the §3 completeness check goes green; the hook-surface
check stays green with two consciously blessed additions.

## Restored (R) — 2 files

| File | What diverged | Verdict / action |
|---|---|---|
| `docs/BRANCH-FORK-MAINTENANCE.md` | Upstream rewrote the doc for the registry-branch model (`5e9e51c5`, after our fork point). Zero fork-side delta. | R — restored byte-identical to `origin/main` (pure upstream advancement; the stale copy described the retired channel-forks model). |
| `src/group-skills.ts` | One word in a comment (`codex, opencode, pi, …` → `codex, pi, …`), from the fork's OpenCode-removal sweep. | R — restored. Comment-only, no functional content, and the mention is a generic example, not an instruction to install the removed provider. Clears a weeks-old publish-gate orphan. |

## Hookified (H) — 2 files

| File | What diverged | Verdict / action |
|---|---|---|
| `eslint.config.js` | The `public/webchat/app.js` / `sw.js` lint block (browser globals, `showToast` options-object rule; PR #344). | H — added to HOOK_FILES + WEBCHAT_HOOK_ALLOWLIST. A fork-only config file was evaluated and rejected: eslint flat config has a single entry point, so any split still diverges `eslint.config.js` (the import line) while adding indirection. The block is genuinely webchat-owned → the reversible 3-way hook is the designed home. |
| `src/host-sweep.test.ts` | `selfHealBloatedContinuation` test suite (bloated-continuation self-heal). | H — added to HOOK_FILES + allowlist. `src/host-sweep.ts` (which carries the feature) is already a blessed hook; the test rides with it, matching the existing pattern (`apply.test.ts`, `response-handler.test.ts`, …). |

## Kept (K) — delivered by HOOK_FILES (59 files)

All of these are the designed overlay mechanism (reversible 3-way patches at
install time) and are on the blessed allowlist. Not churned.

`.gitignore`, `CLAUDE.md`, `container/Dockerfile`, `pnpm-workspace.yaml`,
`src/backfill-container-configs.ts`, `src/channels/adapter.ts`,
`src/channels/channel-registry.ts`, `src/cli/resources/destinations.ts`,
`src/cli/resources/groups.ts`, `src/cli/resources/groups.test.ts`,
`src/container-config.ts`, `src/container-runner.ts`, `src/container-runner.test.ts`,
`src/container-runtime.ts`, `src/container-runtime.test.ts`,
`src/db/agent-groups.ts`, `src/db/container-configs.ts`, `src/db/schema.ts`,
`src/db/session-db.ts`, `src/db/session-db.test.ts`, `src/db/sessions.ts`,
`src/delivery.ts`, `src/egress-lockdown.ts`, `src/group-init.ts`,
`src/host-sweep.ts`, `src/index.ts`, `src/router.ts`, `src/session-manager.ts`,
`src/types.ts`, `src/modules/index.ts`,
`src/modules/agent-to-agent/agent-route.ts`, `…/agent-route.test.ts`,
`…/message-gate.test.ts`, `…/write-destinations.ts`,
`src/modules/approvals/onecli-approvals.ts`, `…/primitive.ts`,
`…/response-handler.ts`, `…/response-handler.test.ts`,
`src/modules/self-mod/apply.ts`, `src/modules/typing/index.ts`,
`…/typing/index.test.ts`,
`container/agent-runner/src/config.ts`, `…/db/connection.ts`,
`…/db/messages-out.ts`, `…/destinations.ts`, `…/formatter.ts`,
`…/formatter.test.ts`, `…/index.ts`, `…/integration.test.ts`,
`…/mcp-tools/cli.instructions.md`, `…/mcp-tools/core.instructions.md`,
`…/mcp-tools/index.ts`, `…/mcp-tools/server.ts`, `…/poll-loop.ts`,
`…/poll-loop.test.ts`, `…/providers/claude.ts`, `…/providers/mock.ts`,
`…/providers/types.ts`, `…/upload-trace.test.ts`

Note: `container/Dockerfile` pins and all migration/schema content were left
untouched by this pass, per the audit's ground rules.

## Kept (K) — delivered by dedicated installer steps

| File | What diverged | Coverage |
|---|---|---|
| `src/channels/index.ts` | webchat adapter self-registration import | installer step 3 (idempotent barrel append) |
| `src/db/migrations/index.ts` | webchat + learning + user-credentials migration registrations | installer steps 4/4a (auto-derived registration) |
| `package.json` | webchat runtime deps (`ws`, `busboy`, `web-push`, `undici`, MCP SDK), e2e scripts, webchat lint targets | installer step 5 (deps) |
| `pnpm-lock.yaml` | lockfile for the above | installer step 5 |

## Kept (K) — repo documentation / OpenCode-removal sweep (never delivered by the overlay)

The fork deleted the OpenCode provider (`39d5e7a0`); every reference sweep edit is
load-bearing — restoring would point users at a provider/skill that does not exist
on this fork. All are inside the gate's documented `README*/docs/*/.claude/skills/*`
coverage classes.

| File | What diverged |
|---|---|
| `README.md` | OpenCode removal, `/add-litellm` recommendation, webchat GUI bullet |
| `README_ja.md`, `README_ko.md`, `README_zh.md` | Translated equivalents of the same README.md edits. **Not restorable** (they'd re-document `/add-opencode`). Were orphans for weeks because the gate's root-docs class only named `README.md` — the class now covers all README languages. |
| `CHANGELOG.md` | providers-branch entry updated (OpenCode → litellm path) |
| `CONTRIBUTING.md` | OpenCode example references removed |
| `docs/architecture.md` | OpenCode column removed from media-handling table |
| `docs/architecture-diagram.md`, `docs/architecture-diagram.html` | provider node label (opencode → codex) |
| `docs/agent-runner-details.md` | OpenCode provider example section removed |
| `docs/ollama.md` | OpenCode mention removed from caching scope note |
| `docs/skill-guidelines.md` | exemplar list: `add-opencode`/`add-codex` → `add-codex` |
| `.claude/skills/add-opencode/{SKILL.md,REMOVE.md,opencode-dockerfile.test.ts}` | deleted with the provider — restoring would resurrect a broken skill |
| `.claude/skills/customize/SKILL.md`, `.claude/skills/update-skills/SKILL.md`, `.claude/skills/add-mnemon/SKILL.md`, `.claude/skills/add-karpathy-llm-wiki/llm-wiki.md` | OpenCode reference sweep |
| `.claude/skills/add-codex/SKILL.md` | redirects the payload to the fork's `providers-codex` branch (carries the MCP-union writer patch; synced via `scripts/sync-providers-codex.sh`) — load-bearing |

## Kept (K) — repo infra / base-install tooling (gate coverage classes)

| File | What diverged | Coverage |
|---|---|---|
| `.github/workflows/ci.yml` | forgejo-runner fixes: no `setup-node` (broken on Forgejo Actions), no `format:check` (upstream base doesn't hold the standard), gate `channels-webchat`, push-after-merge run, concurrency | `.github/*` class |
| `.github/workflows/label-pr.yml` | GitHub-only guard (`github-script` 404s on Forgejo) | `.github/*` class |
| `.husky/pre-commit` | staged-scope prettier (tree-wide `format:fix` rewrote ~21 legacy files per commit) + `src/**/*.ts` glob bug fix | **new** `.husky/*` class |
| `scripts/skill-apply.ts` | gitless-deploy `from-branch` fallback (tarball installs have no `.git`) + `substituteForLog` secret masking — the `deploy/` installer depends on both | **new** `scripts/*` class |
| `scripts/skill-apply.test.ts` | tests for the above | `scripts/*` class |
| `setup/auto.ts` | headless no-TTY fix (cloud-init/CI) + OpenCode removal in provider picker comment | `setup/*` class |
| `setup/index.ts` | `provider-install` step registration | `setup/*` class |
| `setup/lib/skill-driver.ts` | `logCmd` seam — masked command rendering so prompted secrets never hit the raw setup log | `setup/*` class |
| `setup/onecli.ts` | `persistOnecliBindHost` — pins `ONECLI_BIND_HOST` in `~/.onecli/.env` so `docker compose up` can't drop the gateway to loopback | `setup/*` class |
| `setup/onecli.test.ts` | tests for the above | `setup/*` class |
| `setup/uninstall/remove.test.ts` | chmod-based failure injection → `copyFileSync` spy (root in CI containers bypasses permission bits) | `setup/*` class |
| `src/templates/create-agent.test.ts` | `testTimeout: 30_000` — the forgejo runner starves the 5 s default under the full suite; restoring would reintroduce a flaky CI gate | **new** narrow coverage entry |
| `versions.json` | `onecli-gateway` 1.36.0 → 1.37.0 — the `credential_not_found` gateway regression fix; **must not** be restored | **new** narrow coverage entry |

## Orphan fixes outside the upstream-file audit (fork-only files)

Flagged by the same gate run; fixed with the designed mechanisms:

| File | Fix |
|---|---|
| `src/db/migrations/module-learning-master.ts` | added to NEW_PATHS (installer step 4a auto-registers it) — genuine delivery omission from the Auto-learn master switch |
| `src/db/migrations/module-learning-classifier.ts` | added to NEW_PATHS (same; classifier gate). Ordering preserved: config → master → classifier → mcp-hardening, matching the branch's migrations array |
| `container/agent-runner/src/learning-classifier.test.ts` | added to NEW_PATHS next to the other learning tests |
| `.husky/pre-push`, `scripts/pr-preflight.sh`, `scripts/sync-providers-codex.sh` | fork dev tooling — covered by the new `.husky/*` / `scripts/*` classes |

## Result

- Restored: 2 · Hookified: 2 · Kept: 96 (59 HOOK_FILES + 4 installer steps + 33 documented coverage classes)
- Publish gate §3 (completeness): 17 orphans → 0
- Publish gate §3b (hook surface): green before and after (+2 consciously blessed hooks)
- Untouched by design: `container/Dockerfile` pins, all migration/schema content
