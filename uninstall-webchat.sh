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
  CLAUDE.md
  src/modules/agent-to-agent/create-agent.ts
  src/modules/agent-to-agent/agent-route.ts
  src/modules/approvals/primitive.ts
  src/modules/approvals/response-handler.ts
  container/agent-runner/src/destinations.ts
  container/agent-runner/src/poll-loop.ts
  container/agent-runner/src/db/messages-out.ts
  container/agent-runner/src/providers/claude.ts
  container/agent-runner/src/providers/mock.ts
  src/channels/adapter.ts
  src/channels/channel-registry.ts
  src/cli/resources/destinations.ts
  src/delivery.ts
  src/index.ts
  src/router.ts
  src/types.ts
  src/db/agent-groups.ts
  pnpm-workspace.yaml
  src/session-manager.ts
  container/agent-runner/src/db/connection.ts
  container/agent-runner/src/providers/types.ts
  src/db/schema.ts
  src/db/session-db.ts
  src/db/session-db.test.ts
  src/container-runner.ts
  src/modules/agent-to-agent/agent-route.test.ts
  src/modules/agent-to-agent/message-gate.test.ts
  .gitignore
  src/container-runtime.ts
  src/modules/index.ts
  src/modules/approvals/onecli-approvals.ts
  src/modules/typing/index.ts
  src/modules/typing/index.test.ts
  container/Dockerfile
  container/agent-runner/src/integration.test.ts
  container/agent-runner/src/poll-loop.test.ts
  container/agent-runner/src/mcp-tools/cli.instructions.md
  src/container-config.ts
  container/agent-runner/src/config.ts
  container/agent-runner/src/index.ts
  src/container-runtime.test.ts
  src/host-sweep.ts
  src/cli/resources/groups.ts
  src/cli/resources/groups.test.ts
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

# ── 2b. Reverse provider activity overlays ───────────────────────────────
# Mirror install step 2d: reverse each provider's webchat patch (plain
# --reverse, since the target is untracked) and remove any overlay-installed
# files. reverse-check guards idempotency.
#   marker_file | patch | overlay_file_to_remove
PROVIDER_OVERLAYS=(
  "container/agent-runner/src/providers/codex.ts|webchat-hooks/codex-activity.patch|container/agent-runner/src/providers/codex-activity.test.ts"
)
echo "→ Reversing provider activity overlays …"
for entry in "${PROVIDER_OVERLAYS[@]}"; do
  IFS='|' read -r marker patch extra <<< "$entry"
  if [ -f "$marker" ] && PCONTENT=$(git show "$BR:$patch" 2>/dev/null); then
    if echo "$PCONTENT" | git apply --reverse --check 2>/dev/null; then
      echo "$PCONTENT" | git apply --reverse
      echo "  ← ${patch##*/}: overlay reversed"
    else
      echo "  = ${patch##*/}: overlay not present (skip)"
    fi
  fi
  if [ -n "${extra:-}" ] && [ -f "$extra" ]; then
    rm -f "$extra"
    echo "  ← ${extra##*/}: removed"
  fi
done

# ── 3. Remove webchat-owned files ────────────────────────────────────────
echo "→ Removing webchat-owned files …"
rm -rf \
  src/channels/webchat \
  public/webchat \
  src/session-teardown.ts \
  src/session-teardown.test.ts \
  src/router.agent-loopback.test.ts \
  src/router.agent-status.test.ts \
  src/router.backtick-escape.test.ts \
  container/agent-runner/src/graceful-degradation.test.ts \
  src/modules/agent-status \
  container/agent-runner/src/db/status-events.test.ts \
  container/agent-runner/src/providers/summarize-thinking.test.ts \
  src/onecli-preflight.ts \
  src/onecli-preflight.test.ts \
  src/mcp-server-config.ts \
  src/mcp-server-config.test.ts \
  src/modules/user-credentials \
  src/db/migrations/020-byok-credentials.ts \
  src/db/migrations/021-byok-oauth.ts \
  src/db/migrations/022-byok-provider.ts \
  src/db/migrations/023-byok-user-credentials.ts \
  src/db/migrations/024-rename-user-credentials.ts \
  setup/get-oauth-token.sh \
  docs/design/user-credentials.md \
  docs/design/user-credentials-oauth.md \
  docs/design/webchat-threads.md \
  docs/design/webchat-threads-qa.md \
  docs/design/thread-engaged-agents.md \
  docs/design/webchat-thread-context-sync.md

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

const target = 'src/db/migrations/index.ts';
let src = readFileSync(target, 'utf8');
const before = src;

// Drop the whole webchat import block.
src = src.replace(
  /import \{[^}]*\} from ['"]\.\.\/\.\.\/channels\/webchat\/migration\.js['"];\n*/,
  '',
);

// Drop every webchat entry from the migrations array. Match any
// `moduleWebchat*,` line generically — no hand-maintained list to drift,
// and no dependency on the (already-removed) module source. Mirrors install
// step 4's auto-derive.
src = src.replace(/^\s*moduleWebchat[A-Za-z0-9]*,\n/gm, '');

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
