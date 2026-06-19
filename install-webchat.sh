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

# ── 2. Fetch the channel branch ──────────────────────────────────────────
echo "→ Fetching $WEBCHAT_REMOTE/channels-webchat …"
git fetch "$WEBCHAT_REMOTE" channels-webchat
BR="$WEBCHAT_REMOTE/channels-webchat"
# Fork point of the channel branch from your trunk — the basis every webchat
# hook is computed against. `git diff $BASE $BR -- <file>` is exactly the
# webchat delta for that file, independent of how far your trunk has moved.
BASE=$(git merge-base "$BR" HEAD)

# ── 2a. Webchat-owned NEW files: copy in wholesale ───────────────────────
# These do not exist upstream, so copying them clobbers nothing and uninstall
# is a plain remove. Source-of-truth stays on the channel branch (buildable,
# testable, reviewable) — same model as every other /add-<channel> skill.
NEW_PATHS=(
  src/channels/webchat
  public/webchat
  src/session-teardown.ts
  src/session-teardown.test.ts
  src/router.agent-loopback.test.ts
  src/router.agent-status.test.ts
  src/router.backtick-escape.test.ts
  container/agent-runner/src/graceful-degradation.test.ts
  src/modules/agent-status
  container/agent-runner/src/db/status-events.test.ts
  container/agent-runner/src/providers/summarize-thinking.test.ts
)
echo "→ Copying webchat-owned files …"
git checkout "$BR" -- "${NEW_PATHS[@]}"

# ── 2b. Core-file hooks: guarded, reversible 3-way patch ─────────────────
# Each of these files EXISTS upstream and webchat only adds hooks to it. We
# never overwrite your copy (which would silently drop your local changes or
# upstream improvements). Instead we compute the webchat delta and apply it:
#   • reverse-check first  → already applied? skip (idempotent re-runs)
#   • git apply --3way     → merges the hook around your version, tolerating
#                            upstream drift
#   • on conflict          → revert the file and report it; never leave
#                            conflict markers that would break the build
# uninstall-webchat.sh reverses exactly these same deltas.
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
)
CONFLICTS=()
echo "→ Applying webchat core-file hooks …"
for f in "${HOOK_FILES[@]}"; do
  PATCH=$(mktemp)
  git diff "$BASE" "$BR" -- "$f" > "$PATCH"
  if [ ! -s "$PATCH" ]; then
    echo "  = $f: no webchat delta (skip)"
  elif git apply --reverse --check "$PATCH" 2>/dev/null; then
    echo "  = $f: hook already applied (skip)"
  elif git apply --3way "$PATCH" 2>/dev/null; then
    echo "  → $f: hook applied"
  else
    # 3-way could not reconcile — restore the file (clearing any unmerged
    # index state from the failed apply) and flag for the human.
    git checkout HEAD -- "$f" 2>/dev/null || true
    CONFLICTS+=("$f")
    echo "  !! $f: webchat hook conflicts with your version — left unchanged" >&2
  fi
  rm -f "$PATCH"
done

# ── 2c. Leave all changes unstaged ───────────────────────────────────────
# `git checkout <ref> --` and `git apply --3way` both stage their changes.
# Unstage the webchat paths so you review a plain working-tree diff and choose
# what to commit — and so a later uninstall reverses to a clean tree.
git reset -q -- "${NEW_PATHS[@]}" "${HOOK_FILES[@]}" 2>/dev/null || true

# ── 3. Channels barrel: idempotent append ───────────────────────────────
if ! grep -qF "'./webchat/index.js'" src/channels/index.ts; then
  echo "→ Registering channel adapter in src/channels/index.ts"
  echo "import './webchat/index.js';" >> src/channels/index.ts
else
  echo "= Channel adapter already registered (skip)"
fi

# ── 4. Migrations index: idempotent, auto-derived registration ──────────
# The set AND order of webchat migrations are read straight from the channel
# branch's own migrations array — the single source of truth. There is no
# hardcoded symbol list to drift when webchat adds a migration; a new one
# just appears here automatically. Each symbol is then checked independently
# against the user's array body, so re-installs / upgrades add only what's
# missing. (Heredoc'd temp script to dodge bash-escape gymnastics in the
# regex literals.)
WEBCHAT_SYMBOLS=$(git show "$BR:src/db/migrations/index.ts" \
  | sed -n '/const migrations: Migration\[\] = \[/,/\];/p' \
  | grep -oE 'moduleWebchat[A-Za-z0-9]*')
if [ -z "$WEBCHAT_SYMBOLS" ]; then
  echo "install-webchat: no webchat migrations found on $BR — aborting" >&2
  exit 1
fi
TMPFILE=$(mktemp --suffix=.mjs)
cat > "$TMPFILE" <<'NODE_EOF'
import { readFileSync, writeFileSync } from 'node:fs';

// Symbols + order come from the channel branch (via $WEBCHAT_SYMBOLS), so this
// list can never fall out of sync with what webchat actually ships.
const SYMBOLS = process.env.WEBCHAT_SYMBOLS.trim().split(/\s+/);

const target = 'src/db/migrations/index.ts';
let src = readFileSync(target, 'utf8');
let changed = false;

const IMPORT_BLOCK =
  `import {\n${SYMBOLS.map((s) => '  ' + s).join(',\n')},\n} from '../../channels/webchat/migration.js';`;

if (src.includes("from '../../channels/webchat/migration.js'")) {
  // Already imported — replace the block in place so a new SYMBOLS list
  // (post-upgrade) is fully reflected. No-op if nothing changed.
  //
  // [^}]* (not [\s\S]*?) makes the match local to one import block —
  // crucial because other imports also use `import { ... } from '...';`
  // and a too-greedy regex would eat everything between the first import
  // and this one.
  const before = src;
  src = src.replace(
    /import \{[^}]*\} from ['"]\.\.\/\.\.\/channels\/webchat\/migration\.js['"];/,
    IMPORT_BLOCK,
  );
  if (before !== src) changed = true;
} else {
  // Fresh insert — put it right before the first `export`, with a blank
  // line on either side.
  src = src.replace(/^(export )/m, IMPORT_BLOCK + '\n\n$1');
  changed = true;
}

const arrayMatch = src.match(/(const migrations: Migration\[\] = \[[\s\S]*?)\];/);
if (!arrayMatch) {
  console.error('migrations array not found — upstream `src/db/migrations/index.ts` schema changed?');
  process.exit(1);
}
const arrayBody = arrayMatch[1];
const missing = SYMBOLS.filter((s) => !arrayBody.includes(s + ','));
if (missing.length > 0) {
  const block = missing.map((s) => '  ' + s + ',\n').join('');
  src = src.replace(
    /(const migrations: Migration\[\] = \[[\s\S]*?)\];/,
    '$1' + block + '];',
  );
  changed = true;
}

if (changed) {
  writeFileSync(target, src);
  console.log(`→ Registered ${SYMBOLS.length} webchat migrations in ${target}` +
              (missing.length > 0 && missing.length < SYMBOLS.length
                ? ` (+${missing.length} new since last install)`
                : ''));
} else {
  console.log(`= Migrations already registered (skip)`);
}
NODE_EOF
WEBCHAT_SYMBOLS="$WEBCHAT_SYMBOLS" node "$TMPFILE"
rm -f "$TMPFILE"

# ── 4b. Surface any unresolved hooks before the build ────────────────────
# A conflicted hook was reverted to your version, so the webchat code that
# depends on it will fail to typecheck in step 6. Warn loudly and point at
# the cause: the channel branch is stale relative to your trunk for this
# file and needs rebasing.
if [ "${#CONFLICTS[@]}" -gt 0 ]; then
  echo "" >&2
  echo "⚠  ${#CONFLICTS[@]} webchat hook(s) could not auto-apply (upstream drift):" >&2
  for f in "${CONFLICTS[@]}"; do echo "     - $f" >&2; done
  echo "   They were left at your version. The build below will fail until these" >&2
  echo "   files are reconciled — rebase $BR onto your trunk for them, then re-run." >&2
  echo "" >&2
fi

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

Optional add-on: secure shared-room BYOK — several people in one room, each
billing their own turns to their own Anthropic API key or Claude subscription.
Opt-in, off by default; run /add-byok (needs OneCLI: /init-onecli).
DONE
