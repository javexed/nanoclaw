#!/usr/bin/env bash
# ── NanoClaw fresh-host installer ───────────────────────────────────────────
# Installs NanoClaw + the webchat setup wizard on a FRESH Debian/Ubuntu host — a
# VM, a Raspberry Pi, bare metal, or a container guest — and leaves it printing a
# browser URL + bearer token. Everything credential- and model-related (Claude/
# Codex sign-in, or local Ollama install + model download, or the first agent) is
# done by the operator in that browser wizard — this script never touches auth
# and needs no API key.
#
#   sudo bash install.sh
#   # or piped:  curl -fsSL <raw-url>/deploy/install.sh | sudo bash
#
# It leans on the repo's own non-interactive setup driver (`pnpm run setup:auto`)
# for the deps/Docker/OneCLI/agent-image/service steps — the interactive ones
# (auth, channel, first-chat, cli-agent, timezone) are skipped because the wizard
# owns them. Only the webchat .env + bearer token are seeded here.
#
# Works on x86_64 and arm64 (Raspberry Pi). On a Pi the Claude/API path is the
# sweet spot; local models (Ollama) want an x86 box with more RAM.
set -euo pipefail

# Minimal Debian images (esp. LXC templates) inherit LANG=en_US.UTF-8 from the
# caller but never generated that locale, so apt/perl spew "Cannot set LC_*"
# warnings and fall back to C. C.UTF-8 is built into glibc (no locale-gen), so
# forcing it quiets the noise without installing anything.
export LANG=C.UTF-8 LC_ALL=C.UTF-8

# ── Config (env-overridable) ────────────────────────────────────────────────
REPO_URL="${NANOCLAW_REPO_URL:-https://github.com/javexed/nanoclaw.git}"
REPO_BRANCH="${NANOCLAW_REPO_BRANCH:-channels-webchat}" # where webchat + wizard live (not trunk)
INSTALL_DIR="${NANOCLAW_DIR:-/opt/nanoclaw}"
RUN_USER="${NANOCLAW_USER:-nanoclaw}"
WEBCHAT_PORT="${WEBCHAT_PORT:-3100}"
DISPLAY_NAME="${NANOCLAW_DISPLAY_NAME:-operator}"

log() { echo -e "\033[1;36m[nanoclaw]\033[0m $*"; }
die() {
  echo -e "\033[1;31m[nanoclaw] ERROR:\033[0m $*" >&2
  exit 1
}
[ "$(id -u)" -eq 0 ] || die "run as root (sudo bash install.sh)"
command -v apt-get >/dev/null || die "this provisioner targets Debian/Ubuntu (apt)"

# ── CPU capability preflight (x86 only) ─────────────────────────────────────
# The Claude Code CLI is a native x86 binary that needs AVX2/SSE4.2. On an x86 VM
# whose CPU model hides them (e.g. Proxmox's default kvm64, "Common KVM
# processor") it HANGS silently — the webchat OAuth sign-in mint times out and
# Claude agent turns stall — while node/bun/curl run fine, so the cause is
# invisible. Warn loudly so it's a two-minute fix (set the VM CPU type to 'host'
# — on Proxmox `qm set <id> --cpu host` — and reboot), not an hour of
# head-scratching. Non-fatal: the install and the local-model path still work.
# arm64 (Raspberry Pi) runs a different binary and is unaffected — skip it there.
if [ "$(uname -m)" = "x86_64" ] && [ -r /proc/cpuinfo ] && ! grep -qm1 avx2 /proc/cpuinfo; then
  echo -e "\033[1;33m
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  WARNING: this x86 CPU has no AVX2. The Claude Code CLI will HANG on it,  │
  │  so Claude sign-in and Claude agent turns won't work (local models still │
  │  will). On a VM: set the CPU type to 'host' (on Proxmox: qm set <id>     │
  │  --cpu host) and reboot. Continuing the install…                          │
  └─────────────────────────────────────────────────────────────────────────┘\033[0m" >&2
fi

# ── 0. Let first-boot cloud-init finish ─────────────────────────────────────
# On a fresh cloud image, cloud-init runs its own apt at first boot
# (package_update/package_upgrade) and holds the dpkg lock for MINUTES. Racing
# it makes our apt fail with "Unable to acquire the dpkg frontend lock". Wait
# for cloud-init to declare done, then wait out any lingering apt/dpkg lock.
if command -v cloud-init >/dev/null 2>&1; then
  log "waiting for cloud-init to finish (first-boot apt can take a few minutes)…"
  cloud-init status --wait >/dev/null 2>&1 || true
fi
if command -v fuser >/dev/null 2>&1; then
  for _ in $(seq 1 120); do
    fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock >/dev/null 2>&1 || break
    sleep 5
  done
fi

# ── 1. OS deps ──────────────────────────────────────────────────────────────
# git/curl to fetch; build-essential+python3 for better-sqlite3's native build;
# zstd for the wizard's Ollama tarball; ca-certificates for TLS fetches.
# -o DPkg::Lock::Timeout=300: belt-and-braces — if something still holds the
# lock, wait up to 5 min for it rather than failing instantly.
log "installing OS packages…"
export DEBIAN_FRONTEND=noninteractive
APT_OPTS="-o DPkg::Lock::Timeout=300"
apt-get $APT_OPTS update -qq
apt-get $APT_OPTS install -y -qq git curl ca-certificates gnupg build-essential python3 zstd sudo >/dev/null

# ── 2. Service user ─────────────────────────────────────────────────────────
if ! id "$RUN_USER" >/dev/null 2>&1; then
  log "creating service user '$RUN_USER'…"
  useradd --create-home --shell /bin/bash "$RUN_USER"
fi
RUN_UID="$(id -u "$RUN_USER")"
# The NanoClaw service and (later) rootless Ollama run as `systemctl --user`
# units — linger keeps that per-user systemd manager alive without a login
# session. NB: the manager caches group membership at launch; §4 refreshes it
# after the docker group is added.
loginctl enable-linger "$RUN_USER" || log "warn: could not enable linger (systemctl --user may need a manual re-enable)"

# ── 3. Node 22 (nodesource) + pnpm ──────────────────────────────────────────
# setup:auto is `tsx setup/auto.ts`, so Node + the repo deps must exist FIRST —
# chicken/egg the `environment` step can't solve. Reuse the repo's own idempotent
# installer once the repo is cloned; bootstrap Node here so the clone can build.
if ! command -v node >/dev/null 2>&1; then
  log "installing Node 22…"
  # Add the NodeSource apt repo via a pinned keyring instead of piping their
  # setup_22.x script to bash. apt then verifies `nodejs` against the signed
  # repo — no arbitrary remote code runs as root. (curl feeds gpg here, not sh.)
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
    gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  chmod a+r /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    >/etc/apt/sources.list.d/nodesource.list
  apt-get $APT_OPTS update -qq
  apt-get install -y -qq nodejs >/dev/null
fi
corepack enable >/dev/null 2>&1 || npm install -g corepack >/dev/null 2>&1 || true

# ── 4. Docker (agent containers) ────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  log "installing Docker…"
  # Add Docker's official apt repo via a pinned keyring instead of piping
  # get.docker.com to sh — same docker-ce, but apt-signature-verified. On a
  # brand-new distro codename Docker hasn't published a repo for yet, fall back
  # to the distro's own signed docker.io (the path webchat-deploy.sh uses).
  . /etc/os-release
  DOCKER_ID="${ID:-debian}"
  [ "$DOCKER_ID" = ubuntu ] || DOCKER_ID=debian # debian/raspbian/other → debian
  install -m 0755 -d /etc/apt/keyrings
  if curl -fsSL "https://download.docker.com/linux/${DOCKER_ID}/gpg" -o /etc/apt/keyrings/docker.asc &&
    chmod a+r /etc/apt/keyrings/docker.asc &&
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${DOCKER_ID} ${VERSION_CODENAME:-} stable" \
      >/etc/apt/sources.list.d/docker.list &&
    apt-get $APT_OPTS update -qq &&
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io >/dev/null; then
    log "installed docker-ce from Docker's signed apt repo"
  else
    log "Docker CE repo unavailable for this release; falling back to distro docker.io…"
    rm -f /etc/apt/sources.list.d/docker.list
    apt-get $APT_OPTS update -qq
    apt-get install -y -qq docker.io >/dev/null
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
fi
# Ensure the service user can reach the daemon socket (idempotent — runs even
# when Docker was already present).
usermod -aG docker "$RUN_USER"
# The per-user systemd manager (started by enable-linger above) resolved its
# supplementary groups BEFORE this usermod, so the NanoClaw service it spawns
# would inherit a stale set WITHOUT `docker` and crash on `docker info`
# ("Container runtime failed to start"). Restart the manager so it — and every
# unit under it — picks up the docker group, then wait for its control socket.
systemctl restart "user@${RUN_UID}.service" 2>/dev/null || true
for _ in $(seq 1 30); do
  [ -S "/run/user/${RUN_UID}/systemd/private" ] && break
  sleep 1
done

# ── 5. Clone + build ────────────────────────────────────────────────────────
if [ ! -d "$INSTALL_DIR/.git" ]; then
  log "cloning $REPO_URL ($REPO_BRANCH)…"
  git clone --branch "$REPO_BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
  chown -R "$RUN_USER:$RUN_USER" "$INSTALL_DIR"
fi

log "installing deps + building (this pulls the agent image — several minutes)…"
# XDG_RUNTIME_DIR lets setup:auto's `service` step reach the per-user systemd
# manager (systemctl --user) from this non-login sudo shell — without it the
# service never installs and the whole run silently no-ops.
run_as() { sudo -u "$RUN_USER" -H XDG_RUNTIME_DIR="/run/user/${RUN_UID}" bash -lc "cd '$INSTALL_DIR' && $*"; }
run_as "corepack prepare --activate >/dev/null 2>&1 || true"
run_as "pnpm install --frozen-lockfile"
run_as "pnpm run build"

# ── 6. setup:auto — deps/OneCLI/agent-image/service, NO interactive steps ────
# Skips: auth (wizard mints creds), channel + first-chat (wizard makes the first
# agent), cli-agent (no terminal agent on a headless box), timezone (UTC default;
# clack's confirm needs a TTY cloud-init doesn't have).
log "running setup:auto (deps, OneCLI, agent image, service)…"
run_as "NANOCLAW_BOOTSTRAPPED=1 \
        NANOCLAW_DISPLAY_NAME='$DISPLAY_NAME' \
        NANOCLAW_SKIP='auth,channel,first-chat,cli-agent,timezone' \
        pnpm run setup:auto </dev/null" \
  || die "setup:auto failed — see the guest logs (logs/setup.log). If it hung on a prompt, that's the headless-TTY risk noted in the README."

# ── 7. Seed the webchat .env (the wizard entry point) ───────────────────────
# 0.0.0.0 so it's reachable from the LAN; a bearer token because a LAN-exposed
# assistant must not be open. First browser login auto-becomes owner.
ENV_FILE="$INSTALL_DIR/.env"
TOKEN="$(head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)"
log "enabling webchat with a bearer token…"
set_env() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    echo "${key}=${val}" >>"$ENV_FILE"
  fi
}
touch "$ENV_FILE"
set_env WEBCHAT_ENABLED true
set_env WEBCHAT_HOST 0.0.0.0
set_env WEBCHAT_PORT "$WEBCHAT_PORT"
set_env WEBCHAT_TOKEN "$TOKEN"
# Enable Tailscale identity auth up front so the tailnet flow needs no config:
# reach this over your tailnet and the first Tailscale login becomes owner (the
# wizard's "I'll use Tailscale" opt-in also promotes it if you signed in with the
# token first), after which the bearer token can be retired from Settings.
# Harmless when Tailscale isn't used — the bearer token is checked first, so
# token/LAN access is unaffected; it only logs one boot notice until Tailscale is
# present.
set_env WEBCHAT_TAILSCALE true

# Timezone for agent time-awareness. The host reads TZ from .env and sets it on
# the agent container, so `TZ=<iana>` here is all that's needed — this is the
# headless equivalent of setup:auto's (skipped, TTY-bound) timezone step. Prefer
# the helper's prompt (NANOCLAW_TZ); else the guest's own zone if it's been set
# to something real; else leave it (the agent defaults to UTC).
TZ_VALUE="${NANOCLAW_TZ:-}"
if [ -z "$TZ_VALUE" ]; then
  sys_tz=$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo "")
  case "$sys_tz" in "" | UTC | Etc/UTC) : ;; *) TZ_VALUE="$sys_tz" ;; esac
fi
if [ -n "$TZ_VALUE" ] && [ -f "/usr/share/zoneinfo/$TZ_VALUE" ]; then
  set_env TZ "$TZ_VALUE"
  # Match the guest system zone too, so logs/cron read local.
  timedatectl set-timezone "$TZ_VALUE" 2>/dev/null ||
    { ln -sf "/usr/share/zoneinfo/$TZ_VALUE" /etc/localtime && echo "$TZ_VALUE" >/etc/timezone; } 2>/dev/null || true
  log "timezone: $TZ_VALUE"
elif [ -n "$TZ_VALUE" ]; then
  log "warn: ignoring unknown timezone '$TZ_VALUE' — agent will default to UTC"
fi

chown "$RUN_USER:$RUN_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# ── 8. Start the service so the webchat env takes effect ────────────────────
# setup:auto installed + enabled a per-user unit named nanoclaw-v2-<slug> (the
# slug is install-path-derived, so we can't hardcode it). Discover it and
# (re)start it so it picks up the webchat .env just written — `restart` also
# starts a stopped unit.
log "starting the service…"
UNIT="$(run_as "systemctl --user list-unit-files --no-legend 'nanoclaw-v2-*.service' 2>/dev/null | grep -oE 'nanoclaw-v2-[^ ]+\.service' | head -n1")"
UNIT="${UNIT//[$'\r\n ']/}"
if [ -n "$UNIT" ]; then
  run_as "systemctl --user restart '$UNIT'" \
    || log "warn: could not start $UNIT — inspect: sudo -u $RUN_USER XDG_RUNTIME_DIR=/run/user/$RUN_UID systemctl --user status '$UNIT'"
else
  log "warn: no nanoclaw-v2-*.service unit found — setup:auto's service step may not have run"
fi

# ── 9. Done — print the URL + token ─────────────────────────────────────────
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<EOF

================================================================
 NanoClaw is up. Finish setup in your browser:

   URL:    http://${IP:-<guest-ip>}:${WEBCHAT_PORT}
   Token:  ${TOKEN}

 First login becomes the owner and the setup wizard opens automatically —
 pick Claude (sign in), or install a local model right there. No terminal
 auth needed.
================================================================
EOF
