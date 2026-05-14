#!/usr/bin/env bash
#
# install-webchat.sh — deterministic installer for the webchat channel.
#
# Lives on the channels-webchat branch alongside the source. Invoked by
# the /add-webchat skill or runnable directly:
#
#   bash <(git show <remote>/channels-webchat:install-webchat.sh)
#
# Or, after checking it out:
#
#   git checkout <remote>/channels-webchat -- install-webchat.sh
#   ./install-webchat.sh
#
# Idempotent: re-running on an already-installed tree is a no-op.
# Does NOT touch .env — run configure-webchat.sh after for that.

set -euo pipefail

# ── 0. Locate ourselves ───────────────────────────────────────────────────
cd "$(git rev-parse --show-toplevel)" \
  || { echo "install-webchat: must be run inside a nanoclaw git checkout" >&2; exit 1; }

# ── 1. Detect which remote carries the webchat branches ─────────────────
# The skill/webchat branch you merged to install this skill identifies the
# remote that also hosts channels-webchat. Override with WEBCHAT_REMOTE=<name>.
if [ -z "${WEBCHAT_REMOTE:-}" ]; then
  WEBCHAT_REMOTE=$(git branch -r | grep -E '/skill/webchat$' \
    | awk -F/ '{print $1}' | sort -u | head -1 | xargs)
fi
if [ -z "$WEBCHAT_REMOTE" ]; then
  echo "install-webchat: no remote carries 'skill/webchat'." >&2
  echo "  Fetch the remote first, or set WEBCHAT_REMOTE=<name> explicitly." >&2
  exit 1
fi
echo "→ Using remote: $WEBCHAT_REMOTE"

# ── 2. Fetch + check out channel-owned files ─────────────────────────────
echo "→ Fetching $WEBCHAT_REMOTE/channels-webchat …"
git fetch "$WEBCHAT_REMOTE" channels-webchat

echo "→ Checking out webchat-owned source files …"
git checkout "$WEBCHAT_REMOTE/channels-webchat" -- \
  src/channels/webchat/ \
  public/webchat/ \
  src/modules/agent-to-agent/create-agent.ts \
  src/modules/agent-to-agent/create-agent.test.ts \
  container/agent-runner/src/destinations.ts

# ── 3. Channels barrel: idempotent append ───────────────────────────────
if ! grep -qF "'./webchat/index.js'" src/channels/index.ts; then
  echo "→ Registering channel adapter in src/channels/index.ts"
  echo "import './webchat/index.js';" >> src/channels/index.ts
else
  echo "= Channel adapter already registered (skip)"
fi

# ── 4. Migrations index: idempotent insertion via inline node ───────────
node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';

const target = 'src/db/migrations/index.ts';
let src = readFileSync(target, 'utf8');

const IMPORT_BLOCK =
\`import {
  moduleWebchat,
  moduleWebchatDropRooms,
  moduleWebchatRoomPrimes,
  moduleWebchatModels,
  moduleWebchatApprovalsIndex,
} from '../../channels/webchat/migration.js';

\`;

const ARRAY_ENTRIES =
\`  moduleWebchat,
  moduleWebchatDropRooms,
  moduleWebchatRoomPrimes,
  moduleWebchatModels,
  moduleWebchatApprovalsIndex,
\`;

let changed = false;

if (!src.includes(\"channels/webchat/migration\")) {
  // Insert import block right before the first \`export\`
  src = src.replace(/^(export )/m, IMPORT_BLOCK + '\$1');
  changed = true;
}

// Check the array body specifically — \"moduleWebchatApprovalsIndex\" also
// appears in the import block above, so a top-level src.includes() would
// false-positive after the import is inserted on a fresh run.
const arrayMatch = src.match(/const migrations: Migration\[\] = \[[\\s\\S]*?\];/);
const arrayHasEntries = arrayMatch && arrayMatch[0].includes('moduleWebchatApprovalsIndex');

if (!arrayHasEntries) {
  src = src.replace(
    /(const migrations: Migration\[\] = \[[\\s\\S]*?)\];/,
    '\$1' + ARRAY_ENTRIES + '];',
  );
  changed = true;
}

if (changed) {
  writeFileSync(target, src);
  console.log('→ Registered 5 webchat migrations in ' + target);
} else {
  console.log('= Migrations already registered (skip)');
}
"

# ── 5. Install pinned packages ──────────────────────────────────────────
echo "→ Installing webchat dependencies …"
pnpm add ws@8.20.0 busboy@1.6.0 web-push@3.6.7 undici@7.16.0
pnpm add -D @types/ws@8.18.1 @types/busboy@1.5.4 @types/web-push@3.6.4

# ── 6. Build host ───────────────────────────────────────────────────────
echo "→ Building host (tsc) …"
pnpm run build

# ── 7. Rebuild agent container image ────────────────────────────────────
# The destinations.ts modification lives in agent-runner code baked into
# the container image. Skip with SKIP_CONTAINER_BUILD=1 (e.g., in CI).
if [ "${SKIP_CONTAINER_BUILD:-0}" != "1" ]; then
  echo "→ Rebuilding agent container image …"
  ./container/build.sh
else
  echo "= Skipping container image rebuild (SKIP_CONTAINER_BUILD=1)"
fi

cat <<'DONE'

✓ Webchat installed.

Next: configure environment + auth.
  bash configure-webchat.sh

Or set the .env vars by hand — see .claude/skills/add-webchat/SKILL.md
under "Configure" for the full menu (auth methods, TLS, VAPID).
DONE
