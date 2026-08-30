#!/usr/bin/env bash
#
# deploy/webchat-deploy.sh — headless, network-exposed webchat deploy.
#
# The SINGLE SOURCE OF TRUTH for a non-interactive webchat install: build the
# app, run the non-interactive setup driver, write the .env (network + bearer +
# optional Tailscale), and install a service — systemd on Linux (system or
# --user), a launchd LaunchAgent on macOS. Called by BOTH the Proxmox
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
#   --no-service         don't install a service (systemd / launchd)
#   --display-name NAME  how agents address the operator (default: operator)
#   --localhost          loopback-only, single-user: bind 127.0.0.1, NO bearer
#                        token and NO Tailscale (so the localhost auto-owner
#                        stays on — any explicit auth would disable it), and a
#                        systemd --user service (no root). The most-secure mode
#                        for a personal machine; reachable only from this host.
set -euo pipefail

DIR=""; PORT=3100; HOST=0.0.0.0; TOKEN=""; TZ_VAL=""; ONECLI_URL=""
TAILSCALE=1; SERVICE=1; DISPLAY_NAME=operator; INSTALL_DEPS=0; LOCALHOST=0
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
    # Loopback-only: bind 127.0.0.1, no token, no Tailscale (keep auto-owner).
    # An explicit --host/--token/--tz after this still wins (last flag applies).
    --localhost) LOCALHOST=1; HOST=127.0.0.1; TAILSCALE=0; shift ;;
    -h|--help) sed -n '2,38p' "$0"; exit 0 ;;
    *) echo "webchat-deploy: unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Default DIR = the repo root this script lives in (deploy/..), so a plain
# `bash deploy/webchat-deploy.sh` from a checkout just works.
[ -n "$DIR" ] || DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR" || { echo "webchat-deploy: cannot cd to $DIR" >&2; exit 1; }
say() { echo "→ $*"; }
OS="$(uname -s)"

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
# Localhost mode is the exception: NO token — 127.0.0.1 is trusted and the
# localhost auto-owner signs you in, which any explicit auth method would
# switch off. (If .env already carries a token from a prior networked deploy,
# we leave it; env_set is add-if-missing.)
if [ "$LOCALHOST" != 1 ] && ! env_has WEBCHAT_TOKEN; then
  [ -n "$TOKEN" ] || TOKEN=$(head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)
  env_set WEBCHAT_TOKEN "$TOKEN"
fi
# Tailscale identity up front: reach this over the tailnet and the first Tailscale
# login becomes owner. Harmless when unused — the bearer token is checked first.
[ "$TAILSCALE" = 1 ] && env_set WEBCHAT_TAILSCALE true
# The OneCLI gateway (started by setup:auto) binds the docker bridge, not
# loopback. The host needs its URL to hand credentials to agent containers.
if [ -z "$ONECLI_URL" ]; then
  if [ "$OS" = Darwin ]; then
    # Docker Desktop: no host-visible bridge; published ports land on loopback.
    ONECLI_URL="http://127.0.0.1:10254"
  else
    bridge=$(ip -4 -o addr show docker0 2>/dev/null | awk '{print $4}' | cut -d/ -f1)
    ONECLI_URL="http://${bridge:-172.17.0.1}:10254"
  fi
fi
env_set ONECLI_URL "$ONECLI_URL"
if [ -z "$TZ_VAL" ]; then
  TZ_VAL="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
  # macOS (and minimal Linuxes): /etc/localtime symlinks into zoneinfo.
  [ -n "$TZ_VAL" ] || TZ_VAL="$(readlink /etc/localtime 2>/dev/null | sed 's|.*zoneinfo/||' || true)"
  [ -n "$TZ_VAL" ] || TZ_VAL=UTC
fi
env_set TZ "$TZ_VAL"
say "Wrote .env (webchat on ${HOST}:${PORT})"

# ── 3. System service (root + systemd) ──────────────────────────────────────
# Slug-scoped unit name (same derivation as src/install-slug.ts getSystemdUnit),
# so two NanoClaw checkouts on one machine never clobber each other's service.
# A hard-coded `nanoclaw.service` here once overwrote a coexisting install's
# unit — the exact failure the slug system exists to prevent.
UNIT_NAME="$(cd "$DIR" && node -e 'const {createHash}=require("crypto");console.log("nanoclaw-v2-"+createHash("sha1").update(process.cwd()).digest("hex").slice(0,8))')"
say "Service unit: ${UNIT_NAME}.service"

if [ "$SERVICE" = 1 ] && [ "$OS" = Darwin ]; then
  # macOS: a per-user launchd LaunchAgent — same label derivation as
  # src/install-slug.ts getLaunchdLabel (com.nanoclaw-v2-<slug>), same shape as
  # setup/service.ts, plus the wait-for-onecli ordering the systemd units get
  # (launchd has no ExecStartPre, so the wait runs inside a bash -c wrapper).
  LABEL="com.${UNIT_NAME}"
  PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
  NODE_BIN="$(command -v node)"
  mkdir -p "$HOME/Library/LaunchAgents" "$DIR/logs"
  cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>bash '$DIR/deploy/wait-for-onecli.sh' || true; exec '$NODE_BIN' '$DIR/dist/index.js'</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$HOME/.local/bin</string>
        <key>HOME</key>
        <string>$HOME</string>
    </dict>
    <key>StandardOutPath</key>
    <string>$DIR/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>$DIR/logs/nanoclaw.error.log</string>
</dict>
</plist>
PLIST
  # Unload first: launchd caches a loaded plist's ProgramArguments — a bare
  # re-load keeps the OLD command even after the file changes on disk.
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  say "Installed + started ${LABEL} as a launchd LaunchAgent"
elif [ "$SERVICE" = 1 ] && [ "$(id -u)" = 0 ] && command -v systemctl >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
  cat >"/etc/systemd/system/${UNIT_NAME}.service" <<UNIT
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
# Docker starts the onecli containers, systemd starts us, and nothing orders the
# two — so on a reboot the host can probe a gateway that is still binding its
# port. Wait for it first (warn-and-continue; never blocks the unit).
ExecStartPre=/bin/bash $DIR/deploy/wait-for-onecli.sh
# The wait budget (60s) plus node boot must fit inside the start timeout.
TimeoutStartSec=150
ExecStart=$NODE_BIN $DIR/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now "$UNIT_NAME"
  say "Installed + started ${UNIT_NAME}.service"
elif [ "$SERVICE" = 1 ] && [ "$LOCALHOST" = 1 ] && command -v systemctl >/dev/null 2>&1 \
     && systemctl --user show-environment >/dev/null 2>&1; then
  # Localhost dev box: a per-USER service — no root, starts now and on login.
  # (A root system service is overkill for a single-user loopback install.)
  mkdir -p "$HOME/.config/systemd/user"
  cat >"$HOME/.config/systemd/user/${UNIT_NAME}.service" <<UNIT
[Unit]
Description=NanoClaw (localhost)
After=docker.service

[Service]
Type=simple
WorkingDirectory=$DIR
# Docker starts the onecli containers, systemd starts us, and nothing orders the
# two — so on a reboot the host can probe a gateway that is still binding its
# port. Wait for it first (warn-and-continue; never blocks the unit).
ExecStartPre=/bin/bash $DIR/deploy/wait-for-onecli.sh
# The wait budget (60s) plus node boot must fit inside the start timeout.
TimeoutStartSec=150
ExecStart=$(command -v node) $DIR/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT_NAME"
  # Survive logout without a login session open (best-effort, no prompt).
  command -v loginctl >/dev/null 2>&1 && loginctl enable-linger "$(id -un)" 2>/dev/null || true
  say "Installed + started ${UNIT_NAME}.service as a systemd --user service"
elif [ "$SERVICE" = 1 ]; then
  say "Skipped service install (needs root+systemd, --localhost for a --user unit, or macOS for launchd) — start manually: node $DIR/dist/index.js"
fi

echo ""
if [ "$LOCALHOST" = 1 ]; then
  echo "✓ NanoClaw webchat deployed on 127.0.0.1:${PORT} (localhost only)."
  echo "  Open http://127.0.0.1:${PORT}/ — you're signed in as owner automatically."
else
  TOKEN_OUT=$(grep '^WEBCHAT_TOKEN=' .env | cut -d= -f2- || true)
  echo "✓ NanoClaw webchat deployed on ${HOST}:${PORT}."
  [ -n "$TOKEN_OUT" ] && echo "  Bearer token: $TOKEN_OUT"
  echo "  Open http://<this-host>:${PORT}/ and paste the token — the first login becomes owner."
fi
