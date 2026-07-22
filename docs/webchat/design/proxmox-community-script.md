# Proxmox community script — maintainer notes

User-facing install/update docs live in [../install.md](../install.md) and
[../../../deploy/README.md](../../../deploy/README.md). This page is the
maintainer side: where the script lives, how its two modes work, and the plan
(and blockers) for upstream submission.

## Where it lives

- **Repo**: `github.com/javexed/ProxmoxVED` (fork of
  `community-scripts/ProxmoxVED`), branch **`feat/nanoclaw`**, mirrored to
  forgejo `nanoClaw/ProxmoxVED`. Kept as a single clean commit set on top of
  the fork's `main`; never merged into the fork's own `main` — the branch IS
  the eventual upstream PR head.
- **Files**: `ct/nanoclaw.sh` (LXC creation + `update_script`),
  `install/nanoclaw-install.sh` (in-container install),
  `json/nanoclaw.json` (catalog metadata; logo pinned to a release tag).

## The two source modes

`install/nanoclaw-install.sh` fetches NanoClaw one of two ways:

- **Test mode (current)**: the public `channels-webchat` **branch tarball**
  (`.../archive/refs/heads/channels-webchat.tar.gz`, override via
  `NANOCLAW_SRC_ARCHIVE`) — carries unreleased fixes; a branch archive has no
  `.git`, so the app's first-boot dev-pull tripwire stays quiet.
- **Release mode (for upstream)**: swap that block for
  `fetch_and_deploy_gh_release "nanoclaw" "javexed/nanoclaw" "tarball" "latest" "/opt/nanoclaw"`.
  Requires a GitHub release to exist (see deploy/RELEASING.md); the catalog
  logo pin must match the tag.

Either way the build/config/service work is delegated to the repo's own
`deploy/webchat-deploy.sh` — the same script a clean-VM install runs, so the
two paths cannot drift. The inline fallback block in the install script only
exists for app branches that predate that script.

## Container shape

Debian 13 unprivileged LXC, 2 CPU / 4 GB / 20 GB. Docker runs inside, so the
`ct` script sets `var_keyctl=1` (`var_nesting=1` is the framework default).
`update_script` backs up `data/` + `.env`, redeploys the latest release,
re-runs the shared deploy script, and re-stamps the app's upgrade marker so
the sanctioned-update tripwire doesn't fire. The community unit runs as
**root** — the host chowns bind-mounted group/session dirs to the container
UID at spawn (see deploy/README.md's root-service note).

## Fork-branch test invocation

`COMMUNITY_SCRIPTS_URL` makes `build.func` fetch OUR `install/` script instead
of upstream's:

```bash
COMMUNITY_SCRIPTS_URL="https://raw.githubusercontent.com/javexed/ProxmoxVED/feat/nanoclaw" \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/javexed/ProxmoxVED/feat/nanoclaw/ct/nanoclaw.sh)"
```

## Upstream submission — plan and blockers

Community-scripts uses a two-repo model: new scripts land in **ProxmoxVED**
(develop) via cross-fork PR (`javexed:feat/nanoclaw` →
`community-scripts/ProxmoxVED:main`); a maintainer later promotes to ProxmoxVE
by labeling the tracking issue `Migration To ProxmoxVE`.

Their PR template gates, honestly assessed:

| Gate | Status |
|---|---|
| No Docker ("installed bare-metal") | **Conflict** — NanoClaw is Docker-native by design |
| 600+ GitHub stars | Canonical `nanocoai/nanoclaw` qualifies (30k+); the fork the script installs does not — attribution question |
| ≥6 months old | Close; canonical repo crosses it 2026-07-31 |
| Release tarballs, no `git pull`, no hardcoded creds | ✅ all pass |
| AI-assistance disclosure | Required checkbox — scripts were AI-built per their AGENTS.md, reviewed |

**Plan**: open a Script Request Discussion on community-scripts first, upfront
about Docker and the fork-as-source, and only PR after a maintainer read —
a cold PR that can't tick "No Docker" invites a close-without-review.

## Release checklist interaction

Cutting `vX.Y.Z` on javexed/nanoclaw (RELEASING.md) is what release mode
resolves; bump `json/nanoclaw.json`'s logo pin to the new tag in the same
change.
