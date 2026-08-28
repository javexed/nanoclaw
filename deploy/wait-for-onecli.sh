#!/usr/bin/env bash
# Block until the OneCLI gateway answers — a systemd ExecStartPre guard.
#
# WHY THIS EXISTS. The onecli containers are started by Docker (restart:
# unless-stopped), nanoclaw by systemd. Nothing orders the two, so on a reboot
# the host frequently wins the race and probes a gateway that is still binding
# its port. The in-process preflight now retries (src/onecli-preflight.ts), which
# is the real fix; this guard additionally keeps the host from starting its
# channel adapters and delivery polls during that window, so the first message
# after a reboot doesn't land on a host that cannot yet obtain credentials.
#
# Deliberately WARN-AND-CONTINUE. A gateway that is genuinely down or switched
# off must not crash-loop the unit (Restart=on-failure): non-OneCLI work still
# functions, and the preflight will log the actionable error either way.
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRIES="${ONECLI_WAIT_TRIES:-30}"
SLEEP="${ONECLI_WAIT_SLEEP:-2}"

# Environment wins (systemd may pass it); otherwise read the deployed .env,
# which is where webchat-deploy.sh writes the gateway URL.
url="${ONECLI_URL:-}"
if [ -z "$url" ] && [ -r "$DIR/.env" ]; then
  url=$(sed -n 's/^ONECLI_URL=//p' "$DIR/.env" | head -1 | tr -d "\"' \r")
fi

if [ -z "$url" ]; then
  echo "wait-for-onecli: no ONECLI_URL in environment or $DIR/.env — nothing to wait for"
  exit 0
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "wait-for-onecli: curl not found — skipping the wait" >&2
  exit 0
fi

for _ in $(seq 1 "$TRIES"); do
  # -f so a 4xx/5xx from a half-started gateway doesn't count as ready; any
  # reply at all still beats a refused connection, but readiness means 2xx/3xx.
  if curl -fs -m 2 -o /dev/null "$url"; then
    echo "wait-for-onecli: gateway ready at $url"
    exit 0
  fi
  sleep "$SLEEP"
done

echo "wait-for-onecli: WARN gateway $url unreachable after $((TRIES * SLEEP))s — starting anyway" >&2
exit 0
