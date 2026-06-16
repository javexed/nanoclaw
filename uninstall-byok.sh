#!/usr/bin/env bash
#
# uninstall-byok.sh — reverse of install-byok.sh (per-member shared-room BYOK).
# Reverses every hook, removes BYOK-owned files, rebuilds. Self-skips when a
# step has nothing to undo. Does NOT touch .env, the byok_credentials table,
# or any OneCLI vault secrets/agents already created (revoke those via the UI
# or onecli if you want them gone).
#
#   git checkout <remote>/skill/byok -- uninstall-byok.sh
#   ./uninstall-byok.sh

set -euo pipefail

cd "$(git rev-parse --show-toplevel)" \
  || { echo "uninstall-byok: must be run inside a nanoclaw git checkout" >&2; exit 1; }

if [ -z "${BYOK_REMOTE:-}" ]; then
  BYOK_REMOTE=$(git branch -r | grep -E '/skill/byok$' | awk -F/ '{print $1}' | sort -u | head -1 | xargs)
fi
[ -n "$BYOK_REMOTE" ] || { echo "uninstall-byok: no remote carries a 'skill/byok' branch (set BYOK_REMOTE=)" >&2; exit 1; }
echo "→ Using remote: $BYOK_REMOTE"
git fetch "$BYOK_REMOTE" skill/byok channels-webchat
BR="$BYOK_REMOTE/skill/byok"
BASE=$(git merge-base "$BR" "$BYOK_REMOTE/channels-webchat")
[ -n "$BASE" ] || { echo "uninstall-byok: could not find byok⇄channels-webchat fork point" >&2; exit 1; }

HOOK_FILES=(
  src/session-manager.ts
  src/router.ts
  src/container-runtime.ts
  src/container-runner.ts
  src/modules/index.ts
  src/modules/approvals/onecli-approvals.ts
  src/db/migrations/index.ts
  src/channels/webchat/migration.ts
  src/channels/webchat/migration.test.ts
  src/channels/webchat/db.ts
  src/channels/webchat/server.ts
  public/webchat/app.js
  public/webchat/index.html
  public/webchat/style.css
)
echo "→ Reversing BYOK hooks …"
for f in "${HOOK_FILES[@]}"; do
  PATCH=$(mktemp)
  git diff "$BASE" "$BR" -- "$f" > "$PATCH"
  if [ ! -s "$PATCH" ]; then
    echo "  = $f: no BYOK delta (skip)"
  elif git apply --reverse --check "$PATCH" 2>/dev/null; then
    git apply --reverse "$PATCH"
    echo "  ← $f: hook reversed"
  else
    echo "  = $f: hook not present (skip)"
  fi
  rm -f "$PATCH"
done

echo "→ Removing BYOK-owned files …"
rm -rf src/modules/byok src/db/migrations/016-byok-credentials.ts src/db/migrations/017-byok-oauth.ts

git reset -q -- "${HOOK_FILES[@]}" 2>/dev/null || true
echo "→ Building host (tsc) …"
pnpm run build

cat <<'DONE'

✓ Secure shared-room BYOK uninstalled.

Left in place (remove by hand if you want them gone):
  • byok_credentials table + webchat_room_settings.credential_mode/oauth_allowed in data/v2.db
  • data/byok-oauth.key (host key for OAuth tokens — delete to render any stored
    subscription tokens unrecoverable)
  • OneCLI vault secrets / per-member agents already created (manage via onecli)

To reinstall: bash install-byok.sh
DONE
