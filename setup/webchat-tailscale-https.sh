#!/usr/bin/env bash
#
# webchat-tailscale-https.sh — upgrade a webchat install to HTTPS on its
# tailnet name, with certificate auto-renewal. One atomic run:
#
#   1. tailscale present + logged in (offers install / `tailscale up`)
#   2. mint the cert for this node's <name>.<tailnet>.ts.net
#   3. point WEBCHAT_TLS_CERT/KEY at it in .env
#   4. install the DAILY RENEWAL TIMER (systemd user timer → scripts/
#      renew-webchat-cert.sh, which restarts the server only when the cert
#      actually changed)
#
# The cert and the timer are deliberately one step: a cert without renewal
# goes dark in 90 days, silently, on the only listener. Idempotent — safe to
# re-run. Designed for both the interactive configure-webchat.sh flow and the
# HTTP-first provision flow (Proxmox/Pi): connect over HTTP with the bearer
# token first, run this later, refresh as HTTPS.
#
# Sudo is used at most twice, once each, interactively: installing tailscale
# and making $USER the tailscale operator (so the daily renewal never needs
# root again).

set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || dirname "$(dirname "${BASH_SOURCE[0]}")")"
ROOT="$PWD"

ask() { local a; read -r -p "$1 [$2]: " a || true; echo "${a:-$2}"; }

env_set() {
  local k="$1" v="$2"
  if grep -qE "^${k}=" .env 2>/dev/null; then
    sed -i.bak "s|^${k}=.*|${k}=${v}|" .env && rm -f .env.bak
  else
    echo "${k}=${v}" >> .env
  fi
  echo "→ ${k}=${v}"
}

# ── 1. tailscale installed + up ───────────────────────────────────────────
if ! command -v tailscale >/dev/null 2>&1; then
  echo "Tailscale is not installed."
  if [ "$(ask "Install it now via the official installer (needs sudo)? (y/n)" "y")" = "y" ]; then
    curl -fsSL https://tailscale.com/install.sh | sh
  else
    echo "Aborted — install tailscale and re-run." >&2
    exit 1
  fi
fi

state=$(tailscale status --json 2>/dev/null \
  | python3 -c 'import sys,json; print(json.load(sys.stdin).get("BackendState",""))' 2>/dev/null || echo '')
if [ "$state" != "Running" ]; then
  echo "Tailscale is installed but not connected. Starting login…"
  echo "(a browser URL will print — approve this machine into YOUR tailnet there;"
  echo " headless alternative: sudo tailscale up --authkey <key from the admin console>)"
  sudo tailscale up
fi

# ── 2. this node's HTTPS name ─────────────────────────────────────────────
HOST=$(tailscale status --json \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
if [ -z "$HOST" ]; then
  echo "This tailnet has no MagicDNS name for the node. In the Tailscale admin" >&2
  echo "console enable: DNS → MagicDNS, and DNS → HTTPS Certificates. Re-run after." >&2
  exit 1
fi
echo "→ Node name: $HOST"

# ── 3. mint the cert ──────────────────────────────────────────────────────
mkdir -p data/tls
CERT="$ROOT/data/tls/webchat.crt"
KEY="$ROOT/data/tls/webchat.key"
if ! tailscale cert --cert-file "$CERT" --key-file "$KEY" "$HOST" 2>/dev/null; then
  echo "tailscale cert needs operator rights (one-time sudo; the daily renewal then runs without root)…"
  sudo tailscale set --operator="$USER"
  if ! tailscale cert --cert-file "$CERT" --key-file "$KEY" "$HOST"; then
    echo "Cert mint failed. Most common cause: HTTPS Certificates not enabled" >&2
    echo "for the tailnet (admin console → DNS → HTTPS Certificates)." >&2
    exit 1
  fi
fi
echo "→ Cert minted: $CERT"

# ── 4. wire .env ──────────────────────────────────────────────────────────
env_set WEBCHAT_TLS_CERT "$CERT"
env_set WEBCHAT_TLS_KEY "$KEY"

# ── 5. auto-renewal — installed in the SAME run as the cert ──────────────
chmod +x scripts/renew-webchat-cert.sh
if [ "$(uname)" = "Darwin" ]; then
  echo "⚠  macOS: add a launchd job running scripts/renew-webchat-cert.sh daily" >&2
  echo "   (systemd timer below is Linux-only)." >&2
else
  UNITS="$HOME/.config/systemd/user"
  mkdir -p "$UNITS"
  cat > "$UNITS/webchat-cert-renew.service" <<EOF
[Unit]
Description=Renew webchat Tailscale TLS cert + restart if changed

[Service]
Type=oneshot
ExecStart=$ROOT/scripts/renew-webchat-cert.sh
EOF
  cat > "$UNITS/webchat-cert-renew.timer" <<'EOF'
[Unit]
Description=Daily webchat TLS cert renewal check

[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=1h

[Install]
WantedBy=timers.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now webchat-cert-renew.timer
  echo "→ Renewal timer installed and started (webchat-cert-renew.timer, daily)"
  if ! loginctl show-user "$USER" 2>/dev/null | grep -q 'Linger=yes'; then
    echo "⚠  Lingering is off — user timers stop when you log out. Fix once with:"
    echo "     sudo loginctl enable-linger $USER"
  fi
fi

# ── 6. done — the server reads the cert at boot ───────────────────────────
PORT=$(grep -E '^WEBCHAT_PORT=' .env 2>/dev/null | cut -d= -f2- || true)
echo ""
echo "✓ HTTPS configured. Restart the service to switch listeners:"
echo "    systemctl --user restart nanoclaw-v2-$(printf %s "$ROOT" | sha1sum | cut -c1-8)"
echo "  then open: https://$HOST:${PORT:-3100}"
echo "  (the old http:// origin dies with the restart — reinstall the PWA from the new origin)"
