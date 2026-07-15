#!/bin/bash
# Renew the webchat's Tailscale TLS cert and restart the server only when the
# cert actually changed. Tailscale re-issues in place when the cert nears
# expiry (a no-op otherwise), so this is safe to run daily. The webchat reads
# the cert once at boot (server.ts), so a renewal needs a restart to take
# effect — without this the cert silently expires and HTTPS (the only
# listener) goes dark.
#
# Installed as a daily systemd user timer by setup/webchat-tailscale-https.sh.
# Everything is derived at runtime — nothing is hardcoded per install:
#   cert/key paths  ← WEBCHAT_TLS_CERT/KEY in the repo's .env
#   hostname        ← the cert's own subject CN (what was originally minted)
#   service unit    ← the repo path's install slug (src/install-slug.ts:
#                     sha1(projectRoot)[:8])
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

CERT=$(grep -E '^WEBCHAT_TLS_CERT=' "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2-)
KEY=$(grep -E '^WEBCHAT_TLS_KEY=' "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2-)
if [ -z "$CERT" ] || [ -z "$KEY" ]; then
  echo "WEBCHAT_TLS_CERT / WEBCHAT_TLS_KEY not set in $ROOT/.env — nothing to renew" >&2
  exit 1
fi

# The name the cert was minted for. Falling back to tailscale's own view keeps
# a first run (no cert on disk yet) working.
HOST=$(openssl x509 -in "$CERT" -noout -subject 2>/dev/null | sed -n 's/.*CN[ =]*\([^,/]*\).*/\1/p')
if [ -z "$HOST" ]; then
  HOST=$(tailscale status --json 2>/dev/null \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)
fi
[ -n "$HOST" ] || { echo "cannot determine cert hostname (no cert, no tailscale DNSName)" >&2; exit 1; }

SLUG=$(printf %s "$ROOT" | sha1sum | cut -c1-8)
UNIT="nanoclaw-v2-$SLUG"

fingerprint() { openssl x509 -in "$CERT" -noout -fingerprint 2>/dev/null || echo none; }

before=$(fingerprint)
tailscale cert --cert-file "$CERT" --key-file "$KEY" "$HOST"
after=$(fingerprint)

if [ "$before" != "$after" ]; then
  echo "cert changed ($before -> $after) — restarting $UNIT"
  if [ "$(uname)" = "Darwin" ]; then
    launchctl kickstart -k "gui/$(id -u)/com.$UNIT"
  else
    systemctl --user restart "$UNIT"
  fi
else
  echo "cert unchanged — no restart"
fi
