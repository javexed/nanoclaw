#!/usr/bin/env bash
# install-core-escalation.sh — apply the per-group fallback_provider core seam
# (llm-router.md §16c) to a NanoClaw checkout.
#
#   bash .claude/skills/add-routing/resources/core-escalation/install-core-escalation.sh
#
# This is skill-delivered CORE-FILE surgery, same contract as the webchat
# installer's hook patches: the escalation seam is not part of trunk — it is
# applied to your checkout at install time, reversibly.
#   • reverse-check first  → already applied? skip (idempotent re-runs)
#   • git apply --3way     → merges around your version, tolerating upstream
#                            drift (patch blobs are in channels-webchat history)
#   • on conflict          → restore the file and report it; never leave
#                            conflict markers that would break the build
#
# What it delivers (see SKILL.md "Escalation"):
#   - container_configs.fallback_provider column (migration, runs at next host start)
#   - `ncl groups config update --fallback-provider <name>|none`
#   - poll-loop one-shot escalation on terminal failure (both thrown and
#     terminal-error-result shapes), fresh session, original error preserved
#   - container-runner merge of the fallback provider's env/mounts
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

[ -f package.json ] && grep -q '"name": "nanoclaw"' package.json || {
  echo "install-core-escalation: run from the NanoClaw repo root" >&2
  exit 1
}

# ── 1. Patches (tracked trunk files) ──────────────────────────────────────
CONFLICTS=()
echo "→ Applying core-escalation patches …"
for PATCH in "$HERE"/patches/*.patch; do
  name="${PATCH##*/}"
  if git apply --reverse --check "$PATCH" 2>/dev/null; then
    echo "  = $name: already applied (skip)"
    continue
  fi
  # Snapshot the touched files FIRST: on conflict we restore the working tree
  # as it was, never `git checkout HEAD` — the working tree is routinely ahead
  # of HEAD (synced from the channel branch), and reverting to HEAD silently
  # destroys those newer files. (This exact failure happened twice.)
  SNAP=$(mktemp -d)
  TOUCHED=$(git apply --numstat "$PATCH" | cut -f3)
  for f in $TOUCHED; do
    [ -f "$f" ] && mkdir -p "$SNAP/$(dirname "$f")" && cp "$f" "$SNAP/$f"
  done
  if git apply --3way "$PATCH" 2>/dev/null || git apply "$PATCH" 2>/dev/null; then
    echo "  → $name: applied"
  else
    for f in $TOUCHED; do
      if [ -f "$SNAP/$f" ]; then cp "$SNAP/$f" "$f"; fi
      git restore --staged "$f" 2>/dev/null || true
    done
    CONFLICTS+=("$name")
    echo "  !! $name: conflicts with your checkout — left unchanged" >&2
  fi
  rm -rf "$SNAP"
done

# ── 2. New file (migration) ───────────────────────────────────────────────
cp "$HERE/025-fallback-provider.ts" src/db/migrations/025-fallback-provider.ts
echo "  → migration 025-fallback-provider.ts in place"

# Leave everything unstaged for review (git apply --3way stages on success).
git reset -q 2>/dev/null || true

if [ ${#CONFLICTS[@]} -gt 0 ]; then
  echo ""
  echo "⚠ ${#CONFLICTS[@]} patch(es) conflicted: ${CONFLICTS[*]}" >&2
  echo "  Resolve by hand against the patch files in $HERE/patches, then re-run." >&2
  exit 1
fi

# ── 3. Build + verify ─────────────────────────────────────────────────────
echo "→ Building host …"
pnpm run build
echo "→ Container typecheck + escalation tests …"
(cd container/agent-runner && bun run typecheck && bun test src/integration.test.ts 2>&1 | tail -3)

cat <<'EOF'

✓ Core escalation seam applied.

  1. Restart the host so the migration runs:
       systemctl --user restart <your-nanoclaw-unit>     # Linux
       launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
  2. Arm a group (requires an installed fallback provider, e.g. claude is built in):
       ncl groups config update --id <group-id> --fallback-provider claude
       ncl groups restart --id <group-id>
  3. Add the escalate route to data/litellm/routing/routes.json (see SKILL.md).

Re-running this installer is safe (applied patches are skipped). Reversal:
see REMOVE.md — patches reverse with `git apply --reverse`; the DB column is
left in place (harmless when unused).
EOF
