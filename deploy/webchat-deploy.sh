#!/usr/bin/env bash
#
# deploy/webchat-deploy.sh — headless, network-exposed webchat deploy.
#
# The SINGLE SOURCE OF TRUTH for a non-interactive webchat install: build the
# app, run the non-interactive setup driver, write the .env (network + bearer +
# optional Tailscale), and install a systemd service. Called by BOTH the Proxmox
# community-script (install/nanoclaw-install.sh) AND a clean-VM install, so any
# change to the deploy flow lives here — never duplicated per installer.
#
# Assumes node, pnpm, and docker are already present, and the app is already
# checked out / extracted at --dir. Works on a gitless tree (a release tarball).
# Idempotent: preserves an existing WEBCHAT_TOKEN and re-runs cleanly.
#
# Clean-VM usage — one command, from bare Debian/Ubuntu (installs Node/Docker too):
#   git clone https://github.com/nanocoai/nanoclaw.git nanoclaw && cd nanoclaw
#   sudo bash deploy/webchat-deploy.sh --install-deps --port 3100
# (drop --install-deps if Node 22 + pnpm + Docker are already present).
#
# Full option list:
#   --install-deps       apt-install the distro's Node, pnpm (corepack), Docker
#                        (docker.io) + build deps first — signed OS packages, no
#                        curl|sh. Debian/Ubuntu, needs root, needs distro Node >=20.
#   --dir DIR            app directory (default: this script's repo root)
#   --port N             webchat port (default 3100)
#   --host H             bind host (default 0.0.0.0)
#   --token T            bearer token (default: keep existing, else generate)
#   --tz TZ              timezone (default: system tz, else UTC)
#   --onecli-url URL     OneCLI gateway URL (default: derive docker-bridge:10254)
#   --no-tailscale       don't set WEBCHAT_TAILSCALE=true (it's on by default)
#   --no-service         don't install a systemd service
#   --display-name NAME  how agents address the operator (default: operator)
set -euo pipefail

DIR=""; PORT=3100; HOST=0.0.0.0; TOKEN=""; TZ_VAL=""; ONECLI_URL=""
TAILSCALE=1; SERVICE=1; DISPLAY_NAME=operator; INSTALL_DEPS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --install-deps) INSTALL_DEPS=1; shift ;;
    --dir) DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --tz) TZ_VAL="$2"; shift 2 ;;
    --onecli-url) ONECLI_URL="$2"; shift 2 ;;
    --no-tailscale) TAILSCALE=0; shift ;;
    --no-service) SERVICE=0; shift ;;
    --display-name) DISPLAY_NAME="$2"; shift 2 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "webchat-deploy: unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Default DIR = the repo root this script lives in (deploy/..), so a plain
# `bash deploy/webchat-deploy.sh` from a checkout just works.
[ -n "$DIR" ] || DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR" || { echo "webchat-deploy: cannot cd to $DIR" >&2; exit 1; }
say() { echo "→ $*"; }

# ── 0. Prerequisites (opt-in) ────────────────────────────────────────────────
# Turn a bare Debian/Ubuntu VM into a ready host, using DISTRO packages only —
# signed + vetted by the OS, no `curl | sh` of a third-party installer. Skipped by
# default (the Proxmox framework and dev machines already have these).
if [ "$INSTALL_DEPS" = 1 ]; then
  [ "$(id -u)" = 0 ] || { echo "webchat-deploy: --install-deps needs root (apt + Docker install)" >&2; exit 1; }
  command -v apt-get >/dev/null 2>&1 || { echo "webchat-deploy: --install-deps supports Debian/Ubuntu (apt) only" >&2; exit 1; }
  export DEBIAN_FRONTEND=noninteractive
  say "Installing prerequisites from apt (Node, pnpm, Docker, build tools)…"
  apt-get update -qq
  # docker.io = Debian/Ubuntu's Docker Engine; nodejs+npm = the distro's Node;
  # build-essential + python3 build the native modules (better-sqlite3).
  apt-get install -y -qq ca-certificates curl git build-essential python3 zstd nodejs npm docker.io
  systemctl enable --now docker 2>/dev/null || true
  # The app needs Node >= 20 (package.json engines; .nvmrc pins 22). Debian 12 /
  # Ubuntu 24.04 ship Node 18 — too old — so fail clearly rather than deploy a
  # tree that won't run. Remedy: install Node 22 your way (nvm, a distro backport,
  # or the NodeSource apt repo) and re-run WITHOUT --install-deps.
  # Keeping these version pins current: docs/webchat/dependency-review.md (reviewed quarterly).
  NODE_MAJOR="$(node -v 2>/dev/null | sed 's/v//; s/\..*//')"
  if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 20 ]; then
    echo "" >&2
    echo "webchat-deploy: apt's Node is '${NODE_MAJOR:-missing}' but NanoClaw needs >= 20 (22 preferred)." >&2
    echo "  Your distro ships an older Node. Install Node 22 another way (nvm, a distro" >&2
    echo "  backport, or the NodeSource apt repo), then re-run this WITHOUT --install-deps." >&2
    exit 1
  fi
  # pnpm via corepack (bundled with Node); version pinned by package.json
  # "packageManager". Fallback to a global pnpm if this Node lacks corepack.
  corepack enable 2>/dev/null || npm install -g pnpm
  say "Prerequisites ready (Node $(node -v), Docker via docker.io)."
fi

# ── 1. Build ────────────────────────────────────────────────────────────────
say "Installing dependencies + building (first run pulls a base image, be patient)…"
pnpm install --frozen-lockfile
pnpm run build
# NanoClaw's non-interactive driver builds the agent container image and sets up
# the OneCLI credential vault. Interactive steps are skipped (the browser wizard
# owns them), and so is its systemd --user service — a root system service is
# installed below instead.
say "Running the non-interactive setup driver…"
NANOCLAW_BOOTSTRAPPED=1 NANOCLAW_DISPLAY_NAME="$DISPLAY_NAME" \
  NANOCLAW_SKIP='auth,channel,first-chat,cli-agent,timezone,service' \
  pnpm run setup:auto </dev/null
# Stamp the upgrade marker: a fetched tree carries none, so the first-boot
# dev-pull tripwire would otherwise refuse to start and crash-loop. This deploy
# IS the sanctioned path, so record it.
pnpm exec tsx scripts/upgrade-state.ts set

# ── 2. Configure .env ───────────────────────────────────────────────────────
[ -f .env ] || touch .env
env_has() { grep -q "^$1=" .env; }
env_set() { env_has "$1" || printf '%s=%s\n' "$1" "$2" >> .env; }

env_set WEBCHAT_ENABLED true
env_set WEBCHAT_HOST "$HOST"
env_set WEBCHAT_PORT "$PORT"
# Bearer token: LAN-exposed, so the server needs one; the first browser login
# becomes owner. Preserve any existing token (rotating it locks out current
# logins); else use --token; else generate.
if ! env_has WEBCHAT_TOKEN; then
  [ -n "$TOKEN" ] || TOKEN=$(head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)
  env_set WEBCHAT_TOKEN "$TOKEN"
fi
# Tailscale identity up front: reach this over the tailnet and the first Tailscale
# login becomes owner. Harmless when unused — the bearer token is checked first.
[ "$TAILSCALE" = 1 ] && env_set WEBCHAT_TAILSCALE true
# The OneCLI gateway (started by setup:auto) binds the docker bridge, not
# loopback. The host needs its URL to hand credentials to agent containers.
if [ -z "$ONECLI_URL" ]; then
  bridge=$(ip -4 -o addr show docker0 2>/dev/null | awk '{print $4}' | cut -d/ -f1)
  ONECLI_URL="http://${bridge:-172.17.0.1}:10254"
fi
env_set ONECLI_URL "$ONECLI_URL"
[ -n "$TZ_VAL" ] || TZ_VAL="$(timedatectl show -p Timezone --value 2>/dev/null || echo UTC)"
env_set TZ "$TZ_VAL"
# When installing from a fork/forgejo that carries fork-only payload branches
# (e.g. `providers-codex`), persist the source repo so `from-branch` skill
# installs — codex from Settings — resolve it instead of the nanocoai default.
# Only written when provided; env-load.ts loads it into the host process, and
# env_set is add-if-missing so a re-deploy preserves an operator's value.
if [ -n "${NANOCLAW_CHANNELS_REMOTE_URL:-}" ]; then env_set NANOCLAW_CHANNELS_REMOTE_URL "$NANOCLAW_CHANNELS_REMOTE_URL"; fi
say "Wrote .env (webchat on ${HOST}:${PORT})"

# ── 3. System service (root + systemd) ──────────────────────────────────────
if [ "$SERVICE" = 1 ] && [ "$(id -u)" = 0 ] && command -v systemctl >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
  cat >/etc/systemd/system/nanoclaw.service <<UNIT
[Unit]
Description=NanoClaw
After=docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=$DIR
# A system unit runs with HOME unset; onecli reads its auth token from
# \$HOME/.config, so without this every credential call is Unauthorized (exit 2).
Environment=HOME=/root
ExecStart=$NODE_BIN $DIR/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now nanoclaw
  say "Installed + started the nanoclaw systemd service"
elif [ "$SERVICE" = 1 ]; then
  say "Skipped service install (needs root + systemd) — start manually: node $DIR/dist/index.js"
fi

TOKEN_OUT=$(grep '^WEBCHAT_TOKEN=' .env | cut -d= -f2- || true)
echo ""
echo "✓ NanoClaw webchat deployed on ${HOST}:${PORT}."
[ -n "$TOKEN_OUT" ] && echo "  Bearer token: $TOKEN_OUT"
echo "  Open http://<this-host>:${PORT}/ and paste the token — the first login becomes owner."
