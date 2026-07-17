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

Note: the ProxmoxVED pin lives in a **separate repo** (nanoClaw/ProxmoxVED,
`install/nanoclaw-install.sh`) — bump it there too.

## How to check (quick)

- **Node LTS:** <https://nodejs.org/en/about/previous-releases> — is the pinned
  even-major still Active or Maintenance LTS? Is a newer LTS worth moving to?
- **Docker:** distro-tracked; check <https://docs.docker.com/engine/release-notes/>
  for CVEs, and `apt-cache policy docker.io` on a target distro for its version.
- **pnpm:** <https://github.com/pnpm/pnpm/releases>.

## How to update (if out of date)

1. Bump the pin(s) in **every** row above (Node lives in ~4 files across two repos —
   grep for the old major, e.g. `grep -rn 'node:22\|NODE_VERSION\|\b22\b' …`).
2. Verify on a scratch VM: `deploy/webchat-deploy.sh --install-deps` (or `bash
   nanoclaw.sh`), then `pnpm test` and `./container/build.sh`.
3. Update **Last reviewed** / **Next review due** at the top of this file.
4. Call out the version bump in the deploy PR.
