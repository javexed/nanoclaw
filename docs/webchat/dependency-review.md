# Dependency review — Node / Docker / runtime pins

NanoClaw pins its runtime versions in several places. They do **not** auto-update:
a bump is a deliberate, tested change (a Node major can break native modules like
`better-sqlite3`; a base-image change shifts the whole agent container). Review
them on a schedule so they don't silently rot behind upstream LTS + security
releases.

**Last reviewed:** 2026-07-16
**Next review due:** 2026-10-16
**Cadence:** quarterly — and additionally whenever
- a new Node LTS ships (even-numbered major, every October), or
- a Node or Docker security advisory lands on the pinned line.

## What's pinned, and where

| Thing | Pin | Where (grep the old value to find them all) |
|-------|-----|---------------------------------------------|
| Node (preferred) | **22** | `.nvmrc`; `container/Dockerfile` (`FROM node:22-slim`); `deploy/webchat-deploy.sh` (guard + docs); ProxmoxVED `install/nanoclaw-install.sh` (`NODE_VERSION=22`) |
| Node (minimum) | **>= 20** | `package.json` → `engines.node` |
| pnpm | **10.33.0** | `package.json` → `packageManager` (respect `minimumReleaseAge` in `pnpm-workspace.yaml`) |
| Docker | **distro** (`docker.io`) | `deploy/webchat-deploy.sh --install-deps` (apt); Proxmox framework `setup_docker` |
| Agent base image | **node:22-slim** + pinned global CLIs | `container/Dockerfile` |
| Ollama model manifest | **Qwen3 0.6b–8b** (curated footprints + CPU tok/s) | `src/channels/webchat/model-recommend.ts` → `MODEL_MANIFEST` |
| Agent CLIs | Codex **`@openai/codex` 0.138.0** (when installed); Dockerfile-pinned **agent-browser · claude-code · vercel** | Codex: `.claude/skills/add-codex/SKILL.md` (source of truth) + `container/cli-tools.json`; others: `container/Dockerfile` `ARG` pins |

Note: the ProxmoxVED pin lives in a **separate repo** (nanoClaw/ProxmoxVED,
`install/nanoclaw-install.sh`) — bump it there too.

The model manifest isn't a security pin — a stale one just recommends an
older-but-fine local model — but it rots the same way (new small models ship,
footprint/speed estimates drift), so it rides this same quarterly review.

The agent CLIs are pinned deliberately (reproducibility + supply-chain safety),
so being behind is expected — Codex self-nags "update available" in the wizard,
which is cosmetic, not a fault. They release fast, so the review keeps them from
drifting too far behind fixes.

## How to check (quick)

- **Node LTS:** <https://nodejs.org/en/about/previous-releases> — is the pinned
  even-major still Active or Maintenance LTS? Is a newer LTS worth moving to?
- **Docker:** distro-tracked; check <https://docs.docker.com/engine/release-notes/>
  for CVEs, and `apt-cache policy docker.io` on a target distro for its version.
- **pnpm:** <https://github.com/pnpm/pnpm/releases>.
- **Ollama model manifest:** the wizard recommends a local model from `MODEL_MANIFEST`
  (`model-recommend.ts`) — a curated Qwen3 list with hard-coded `footprintGB` +
  `cpuTokS`. Skim <https://ollama.com/library> and the Qwen3 releases for newer
  small/instruct models worth adding, and sanity-check the footprint/speed
  estimates still hold. Update the fixtures in `model-recommend.test.ts` alongside
  any change — the recommendation is pure + fixture-tested.
- **Agent CLIs:** `npm view @openai/codex version` (and the same for `agent-browser`,
  `@anthropic-ai/claude-code`, `vercel`) vs the pins. **Respect the 3-day
  `minimumReleaseAge`** — never jump to a version published <3 days ago (the
  highest-risk supply-chain window); pick the newest release that has *soaked*, not
  the absolute latest. Bump the pin in its source-of-truth file (Codex →
  `add-codex/SKILL.md` **and** `container/cli-tools.json`), skim the CLI's changelog
  for flag/auth-flow breaks the OneCLI gateway relies on, then `./container/build.sh`.

1. Bump the pin(s) in **every** row above (Node lives in ~4 files across two repos —
   grep for the old major, e.g. `grep -rn 'node:22\|NODE_VERSION\|\b22\b' …`).
2. Verify on a scratch VM: `deploy/webchat-deploy.sh --install-deps` (or `bash
   nanoclaw.sh`), then `pnpm test` and `./container/build.sh`.
3. Update **Last reviewed** / **Next review due** at the top of this file.
4. Call out the version bump in the deploy PR.
