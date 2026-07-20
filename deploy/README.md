# NanoClaw — self-host installer

Stand up NanoClaw + the browser **setup wizard** on a fresh Linux host with no
terminal auth. `install.sh` installs an unauthenticated NanoClaw and prints a URL
+ bearer token; **everything credential- and model-related happens in the browser
wizard** — Claude/Codex sign-in, a one-click local-model install, or the first
agent. No API key, no `claude` login on the box.

## Quick start

On a fresh **Debian/Ubuntu** host — a VM, a **Raspberry Pi**, bare metal, or a
container guest:

```bash
curl -fsSL https://raw.githubusercontent.com/javexed/nanoclaw/channels-webchat/deploy/install.sh | sudo bash
```

A few minutes later (it builds the agent image) it prints the webchat **URL +
bearer token**. Open the URL, paste the token, and the setup wizard walks you the
rest of the way — pick Claude (sign in in-browser), or install a local model right
there.

## What it does

Runs the repo's own non-interactive `setup:auto` (deps, Docker, Node, the OneCLI
credential vault, the agent image, and a `systemctl --user` service), then seeds
the webchat `.env` with a generated bearer token. It skips the interactive setup
steps (auth, channel, first agent, timezone) — the browser wizard owns those.

Installs under a dedicated `nanoclaw` service user with a lingering
`systemctl --user` unit, so nothing runs as root beyond the initial package
install.

## Hosts

| Host | Notes |
|------|-------|
| **VM / bare metal (x86_64)** | The default. On a VM the CPU must expose **AVX2** — the Claude CLI is a native x86 binary that hangs without it. Most hypervisors need the CPU type set to **host** (on Proxmox: `qm set <id> --cpu host`); `install.sh` warns loudly if AVX2 is missing. |
| **Raspberry Pi (arm64)** | Works for the **Claude/API path**. Local models (Ollama) want an x86 box with more RAM, so skip them on a Pi. Heavy agent features (headless-browser screenshots/PDF) may need extra ARM testing. |
| **LXC / container guest** | Fine, but Docker-in-container needs the right flags (on Proxmox LXC: `nesting=1,keyctl=1`). |

## Tailscale (recommended)

`install.sh` sets `WEBCHAT_TAILSCALE=true` so the tailnet flow needs no extra
config. Add Tailscale to the host, then reach NanoClaw **over your tailnet** at
`http://<tailnet-name>:3100` — the **first Tailscale login becomes owner**. (If
you signed in with the token first, tick *"I'll use Tailscale"* in the wizard and
your first Tailscale login is promoted instead.) Once you're on the tailnet the
wizard / Settings offers to **enable HTTPS** (`tailscale serve`, for a real
certificate → PWA install, push, voice) and to **retire the bearer token**. Until
Tailscale is present the bearer token carries access — it's checked first, so a
plain LAN + token setup is unaffected.

## Configuration (env overrides)

| Var | Default | Purpose |
|-----|---------|---------|
| `NANOCLAW_DIR` | `/opt/nanoclaw` | Install directory |
| `NANOCLAW_USER` | `nanoclaw` | Service user |
| `WEBCHAT_PORT` | `3100` | Webchat port |
| `NANOCLAW_TZ` | host zone | IANA timezone for agent time-awareness |
| `NANOCLAW_REPO_URL` / `NANOCLAW_REPO_BRANCH` | GitHub / `channels-webchat` | Source to clone |

## Updating

Don't `git pull` in the install directory — NanoClaw's startup tripwire guards
against unsanctioned updates and will refuse to start. Use the in-app
`/update-nanoclaw` flow, which repairs the install and re-stamps the version
marker.

## Community-scripts (Proxmox catalog) version

A separate [community-scripts](https://github.com/community-scripts/ProxmoxVE)
(Proxmox VE Helper-Scripts) version — a `ct/` + `install/` rewrite on their
`build.func` framework — is maintained independently (root system service,
`setup_docker`, no `install.sh`) and isn't kept here.

### Updating a tarball (community-scripts) install

That install extracts a release tarball — there's no `.git`, so the git-based
`/update-nanoclaw` flow above doesn't apply. To pull the latest code, re-run the
same fetch + shared deploy the installer uses. The tarball contains only tracked
source, so `data/`, `.env`, `groups/`, `logs/`, and `node_modules/` are left
untouched — it's a safe overlay:

```bash
cd /opt/nanoclaw
# $NANOCLAW_ARCHIVE = the same release-tarball URL the installer fetched
curl -fsSL "$NANOCLAW_ARCHIVE" | tar xz -C /opt/nanoclaw --strip-components=1
bash deploy/webchat-deploy.sh --dir /opt/nanoclaw --port 3100
systemctl restart nanoclaw
```

`webchat-deploy.sh` preserves the existing `WEBCHAT_TOKEN`/`.env` (it only adds
missing keys), runs `pnpm install --frozen-lockfile` + `pnpm run build`, and
rewrites the (unchanged) unit. DB migrations run at startup, so the restart
applies them.

**Root-service note.** The community-scripts unit runs as **root** (no `User=`).
The agent container runs its agent-runner as the non-root `node` user (UID 1000),
so a root-owned host would otherwise fail every spawn with
`EACCES: mkdir '/workspace/agent/memory'`. NanoClaw handles this: when the host is
root it chowns the bind-mounted group/session dirs to the container UID at spawn
(override via `NANOCLAW_CONTAINER_UID` for a non-standard image). An
already-broken install self-heals on the next spawn after updating; to fix it
immediately without waiting: `chown -R 1000:1000 /opt/nanoclaw/groups /opt/nanoclaw/data`.

**Escalation seam.** If auto-routing is installed, the overlay reverts its
`core-escalation` patches to tracked files — re-apply them after updating:
`bash .claude/skills/add-routing/resources/core-escalation/install-core-escalation.sh`.
