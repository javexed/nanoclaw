#!/usr/bin/env bash
#
# configure-webchat.sh — interactive .env config + VAPID key generation.
#
# Run after install-webchat.sh. Idempotent — re-running just verifies and
# skips lines that already exist. Does not rotate VAPID keys.
#
# For TLS, multi-method auth, or advanced configs, edit .env by hand;
# see .claude/skills/add-webchat/SKILL.md under "Configure".

set -euo pipefail

cd "$(git rev-parse --show-toplevel)" \
  || { echo "configure-webchat: must be run inside a nanoclaw git checkout" >&2; exit 1; }

[ -f .env ] || touch .env

env_has() { grep -q "^$1=" .env; }
env_set() { env_has "$1" || echo "$1=$2" >> .env; }

ask() {
  local prompt="$1" default="$2" __out_var="$3" reply
  if ! [ -t 0 ]; then
    printf -v "$__out_var" '%s' "$default"
    return
  fi
  read -r -p "$prompt [$default]: " reply || reply=""
  printf -v "$__out_var" '%s' "${reply:-$default}"
}

# ── 1. Enable the server ────────────────────────────────────────────────
env_set WEBCHAT_ENABLED true
echo "→ WEBCHAT_ENABLED=true (in .env)"

# ── 2. Network access mode ──────────────────────────────────────────────
echo ""
echo "Network access:"
echo "  1) Localhost only      — most secure, only reachable from this machine"
echo "  2) Network accessible  — LAN / tailscale / behind a reverse proxy"
ask "Pick" "1" mode

if [ "$mode" = "2" ]; then
  env_set WEBCHAT_HOST 0.0.0.0
  echo ""
  echo "Authentication for network mode (server refuses to start without one):"
  echo "  b) Bearer token       — works everywhere"
  echo "  t) Tailscale whois    — zero-config for tailnet users"
  echo "  p) Proxy header       — for SSO via oauth2-proxy/Cloudflare/EasyAuth"
  ask "Pick (b/t/p)" "b" auth
  case "$auth" in
    t|T)
      env_set WEBCHAT_TAILSCALE true
      echo "→ WEBCHAT_TAILSCALE=true"
      # Keep a bearer token alongside it as first-access / fallback: you reach
      # the box over the tailnet at http://<node>.ts.net:PORT (identified by
      # `tailscale whois` → the first Tailscale login becomes owner), but the
      # token still lets you in from the LAN before Tailscale is up, or if the
      # daemon is down. Retire it later from the setup wizard / Settings → Access.
      if ! env_has WEBCHAT_TOKEN; then
        token=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))" 2>/dev/null \
          || node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
        env_set WEBCHAT_TOKEN "$token"
        echo "→ WEBCHAT_TOKEN=<generated, see .env> (fallback until Tailscale is up)"
      else
        echo "= WEBCHAT_TOKEN already set (kept as fallback)"
      fi
      echo "  Reach it over your tailnet at http://<node>.ts.net:PORT — the first"
      echo "  Tailscale login there becomes owner. Then turn on real HTTPS from the"
      echo "  setup wizard (or Settings → Access), which runs 'tailscale serve', and"
      echo "  retire the token."
      echo "  Alternative — server-native TLS (no serve proxy; cert + daily"
      echo "  auto-renew timer in one step): bash setup/webchat-tailscale-https.sh"
      echo "  ⚠  Same-machine loopback won't authenticate via tailscale; open the"
      echo "     tailnet hostname/IP, not 127.0.0.1."
      ;;
    p|P)
      ask "Trusted proxy IP/CIDR (or 'auto' for Azure/Cloudflare detect)" "auto" proxy_ips
      env_set WEBCHAT_TRUSTED_PROXY_IPS "$proxy_ips"
      echo "→ WEBCHAT_TRUSTED_PROXY_IPS=$proxy_ips"
      echo "  Adjust WEBCHAT_TRUSTED_PROXY_HEADER if x-forwarded-user isn't your header."
      ;;
    *)
      if ! env_has WEBCHAT_TOKEN; then
        token=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))" 2>/dev/null \
          || node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
        env_set WEBCHAT_TOKEN "$token"
        echo "→ WEBCHAT_TOKEN=<generated, see .env>"
        echo "  ⚠  Save this token — you'll need it the first time you connect."
      else
        echo "= WEBCHAT_TOKEN already set (kept existing)"
      fi
      ;;
  esac
else
  echo "→ Localhost-only (no extra config needed)"
  echo "  ⚠  Reverse-proxy gotcha: if Tailscale Serve / nginx / Caddy / Cloudflare"
  echo "     Tunnel forwards to 127.0.0.1, every request arrives as loopback."
  echo "     Either tear that down or set explicit auth above."
fi

# ── 3. VAPID keys for web push ──────────────────────────────────────────
echo ""
if env_has WEBCHAT_VAPID_PUBLIC_KEY; then
  echo "= VAPID keys already in .env (kept existing — re-running won't rotate)"
else
  echo "→ Generating VAPID key pair for web push …"
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "  pnpm not in PATH. Skipping VAPID key generation." >&2
    echo "  Run 'pnpm exec web-push generate-vapid-keys --json' manually and"
    echo "  add WEBCHAT_VAPID_PUBLIC_KEY / WEBCHAT_VAPID_PRIVATE_KEY to .env."
  else
    keys=$(pnpm exec web-push generate-vapid-keys --json)
    pub=$(echo  "$keys" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).publicKey))")
    priv=$(echo "$keys" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).privateKey))")
    env_set WEBCHAT_VAPID_PUBLIC_KEY  "$pub"
    env_set WEBCHAT_VAPID_PRIVATE_KEY "$priv"
    echo "→ VAPID keys added to .env"
  fi
fi

if ! env_has WEBCHAT_VAPID_SUBJECT; then
  ask "Email for VAPID subject (where push services contact you about deliverability)" "" vapid_email
  if [ -n "$vapid_email" ]; then
    env_set WEBCHAT_VAPID_SUBJECT "mailto:$vapid_email"
    echo "→ WEBCHAT_VAPID_SUBJECT=mailto:$vapid_email"
  else
    echo "= No VAPID subject set — web push will not be fully functional until you set"
    echo "  WEBCHAT_VAPID_SUBJECT=mailto:<email> in .env."
  fi
fi

# ── 4. Sync env into container env dir ──────────────────────────────────
mkdir -p data/env && cp .env data/env/env
echo "→ Synced .env → data/env/env"

cat <<'DONE'

✓ Webchat configured.

Next: restart the host so the new adapter loads.

  # macOS
  launchctl kickstart -k gui/$(id -u)/com.nanoclaw

  # Linux
  systemctl --user restart nanoclaw

Then open http://127.0.0.1:3100/ (or your configured host:port).
Token, if generated, is in .env as WEBCHAT_TOKEN — paste it on first connect.
DONE
