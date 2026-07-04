#!/usr/bin/env bash
# install-recalibration.sh — opt-in nightly recalibration timer (§16e tier-1).
#
#   bash .claude/skills/add-routing/resources/install-recalibration.sh [--time 03:30] [--no-apply]
#
# Installs a systemd USER timer that runs recalibrate.mjs nightly from the
# repo root: writes the report, auto-tunes live.timeout_ms (unless --no-apply),
# and rotates log entries older than 30 days. Idempotent — re-run to update.
# macOS: no launchd unit is generated; add a crontab entry instead:
#   30 3 * * * cd <repo> && node .claude/skills/add-routing/resources/recalibrate.mjs --apply --rotate
set -euo pipefail

TIME="03:30"
APPLY="--apply"
while [ $# -gt 0 ]; do
  case "$1" in
    --time) TIME="$2"; shift 2 ;;
    --no-apply) APPLY=""; shift ;;
    *) echo "install-recalibration: unknown flag $1" >&2; exit 2 ;;
  esac
done

[ -f package.json ] && grep -q '"name": "nanoclaw"' package.json || {
  echo "install-recalibration: run from the NanoClaw repo root" >&2
  exit 1
}
command -v systemctl >/dev/null || {
  echo "install-recalibration: systemd not available — use the crontab line in the header instead." >&2
  exit 1
}

REPO="$(pwd)"
NODE_BIN="$(command -v node)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"

cat > "$UNIT_DIR/nanoclaw-routing-recal.service" <<EOF
[Unit]
Description=NanoClaw routing recalibration (llm-router §16e tier-1)

[Service]
Type=oneshot
WorkingDirectory=$REPO
ExecStart=$NODE_BIN $REPO/.claude/skills/add-routing/resources/recalibrate.mjs $APPLY --rotate
EOF

cat > "$UNIT_DIR/nanoclaw-routing-recal.timer" <<EOF
[Unit]
Description=Nightly NanoClaw routing recalibration

[Timer]
OnCalendar=*-*-* $TIME:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now nanoclaw-routing-recal.timer
systemctl --user list-timers nanoclaw-routing-recal.timer --no-pager | head -3

cat <<EOF

✓ Nightly recalibration installed (runs at $TIME).

  Run now:    systemctl --user start nanoclaw-routing-recal.service
  Reports:    data/litellm/routing/recalibration-<date>.md
  Logs:       journalctl --user -u nanoclaw-routing-recal.service
  Remove:     see REMOVE.md
EOF
