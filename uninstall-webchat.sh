#!/usr/bin/env bash
#
# uninstall-webchat.sh — reverse of install-webchat.sh.
#
# Removes the webchat channel cleanly: reverses every core-file hook,
# deletes the webchat-owned files, unwires the channel barrel + migrations,
# and rebuilds. Safe to run even if webchat is only partially installed —
# every step self-skips when there's nothing to undo.
#
#   git checkout <remote>/channels-webchat -- uninstall-webchat.sh
#   ./uninstall-webchat.sh
#
# Does NOT touch .env (your auth/VAPID config is left in place) and does NOT
# drop any webchat DB tables (the migrations already ran; uninstall only
# unregisters them so they don't re-run on a fresh DB).

set -euo pipefail

cd "$(git rev-parse --show-toplevel)" \
  || { echo "uninstall-webchat: must be run inside a nanoclaw git checkout" >&2; exit 1; }

# ── 1. Locate the channel branch (same detection as install) ─────────────
if [ -z "${WEBCHAT_REMOTE:-}" ]; then
  WEBCHAT_REMOTE=$(git branch -r | grep -E '/skill/webchat$' \
    | awk -F/ '{print $1}' | sort -u | head -1 | xargs)
fi
if [ -z "$WEBCHAT_REMOTE" ]; then
  echo "uninstall-webchat: no remote carries 'skill/webchat'." >&2
  echo "  Fetch the remote first, or set WEBCHAT_REMOTE=<name> explicitly." >&2
  exit 1
fi
echo "→ Using remote: $WEBCHAT_REMOTE"
git fetch "$WEBCHAT_REMOTE" channels-webchat
BR="$WEBCHAT_REMOTE/channels-webchat"
BASE=$(git merge-base "$BR" HEAD)

# ── 2. Reverse the core-file hooks ───────────────────────────────────────
# Same deltas install applied. reverse-check guards idempotency: if a hook
# isn't currently applied (already removed, or never applied), skip it.
HOOK_FILES=(
  src/modules/agent-to-agent/create-agent.ts
  container/agent-runner/src/destinations.ts
  container/agent-runner/src/poll-loop.ts
  src/channels/adapter.ts
  src/cli/resources/destinations.ts
  src/delivery.ts
  src/index.ts
  src/router.ts
  src/session-manager.ts
)
echo "→ Reversing webchat core-file hooks …"
for f in "${HOOK_FILES[@]}"; do
  PATCH=$(mktemp)
  git diff "$BASE" "$BR" -- "$f" > "$PATCH"
  if [ ! -s "$PATCH" ]; then
    echo "  = $f: no webchat delta (skip)"
  elif git apply --reverse --check "$PATCH" 2>/dev/null; then
    git apply --reverse "$PATCH"
    echo "  ← $f: hook reversed"
  else
    echo "  = $f: hook not present (skip)"
  fi
  rm -f "$PATCH"
done

# ── 3. Remove webchat-owned files ────────────────────────────────────────
echo "→ Removing webchat-owned files …"
rm -rf \
  src/channels/webchat \
  public/webchat \
  src/modules/agent-to-agent/create-agent.test.ts \
  src/session-teardown.ts \
  src/session-teardown.test.ts \
  src/router.agent-loopback.test.ts \
  src/router.backtick-escape.test.ts

# ── 4. Unwire the channels barrel ────────────────────────────────────────
if grep -qF "'./webchat/index.js'" src/channels/index.ts; then
  echo "→ Removing channel adapter import from src/channels/index.ts"
  # Delete only the webchat self-registration line; leave other channels.
  grep -vF "import './webchat/index.js';" src/channels/index.ts > src/channels/index.ts.tmp
  mv src/channels/index.ts.tmp src/channels/index.ts
else
  echo "= Channel adapter not registered (skip)"
fi

# ── 5. Unregister migrations ─────────────────────────────────────────────
# Removes the webchat import block and its symbols from the migrations array
# so they don't run on a fresh DB. Existing DBs already applied them; this is
# registration-only, mirroring install step 4.
TMPFILE=$(mktemp --suffix=.mjs)
cat > "$TMPFILE" <<'NODE_EOF'
import { readFileSync, writeFileSync } from 'node:fs';

const SYMBOLS = [
  'moduleWebchat',
  'moduleWebchatDropRooms',
  'moduleWebchatRoomPrimes',
  'moduleWebchatModels',
  'moduleWebchatRoomSettings',
  'moduleWebchatApprovalsIndex',
  'moduleWebchatUserArchives',
];

const target = 'src/db/migrations/index.ts';
let src = readFileSync(target, 'utf8');
const before = src;

// Drop the import block (whole `import { ... } from '.../webchat/migration.js';`).
src = src.replace(
  /import \{[^}]*\} from ['"]\.\.\/\.\.\/channels\/webchat\/migration\.js['"];\n*/,
  '',
);

// Drop each symbol's entry from the migrations array (one `  symbol,` line each).
for (const s of SYMBOLS) {
  src = src.replace(new RegExp('^\\s*' + s + ',\\n', 'm'), '');
}

if (before !== src) {
  writeFileSync(target, src);
  console.log('→ Unregistered webchat migrations from ' + target);
} else {
  console.log('= Migrations not registered (skip)');
}
NODE_EOF
node "$TMPFILE"
rm -f "$TMPFILE"

# ── 6. Remove pinned packages (best-effort) ──────────────────────────────
# These were added by install. `pnpm remove` is a no-op if they're already
# gone. If another customization depends on one of them, re-add it after.
echo "→ Removing webchat dependencies …"
pnpm remove ws busboy web-push undici @types/ws @types/busboy @types/web-push 2>/dev/null \
  || echo "= Some packages already absent (skip)"

# ── 7. Rebuild host + container ──────────────────────────────────────────
echo "→ Building host (tsc) …"
pnpm run build

if [ "${SKIP_CONTAINER_BUILD:-0}" != "1" ]; then
  echo "→ Rebuilding agent container image …"
  ./container/build.sh
else
  echo "= Skipping container image rebuild (SKIP_CONTAINER_BUILD=1)"
fi

cat <<'DONE'

✓ Webchat uninstalled.

Left in place (remove by hand if you want them gone):
  • .env webchat vars (WEBCHAT_*, VAPID keys)
  • any webchat rows already written to data/v2.db

To reinstall: bash install-webchat.sh
DONE
