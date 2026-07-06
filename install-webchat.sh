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

# ── 0a. Flags ─────────────────────────────────────────────────────────────
ALLOW_NO_PROVIDER="${ALLOW_NO_PROVIDER:-0}"
SKIP_SQLITE_VERIFY="${SKIP_SQLITE_VERIFY:-0}"
for arg in "$@"; do
  case "$arg" in
    --allow-no-provider) ALLOW_NO_PROVIDER=1 ;;
    --skip-sqlite-verify) SKIP_SQLITE_VERIFY=1 ;;
  esac
done

# ── 0b. Preflight: require a connected LLM ────────────────────────────────
# Webchat is a UI over agent output — useless with no usable model. Detect any
# connected provider (claude / codex / …) via .env keys or the OneCLI vault.
# claude is always *installed* (baked into trunk), so this gate is about
# *credentials*, not code. Override with --allow-no-provider to install the UI
# now and connect a model later.
provider_connected() {
  if grep -qE '^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY)=.' .env 2>/dev/null; then return 0; fi
  if command -v onecli >/dev/null 2>&1; then
    if onecli secrets list 2>/dev/null | grep -qiE 'anthropic|openai|chatgpt'; then return 0; fi
  fi
  return 1
}
if ! provider_connected; then
  if [ "$ALLOW_NO_PROVIDER" = "1" ]; then
    echo "⚠  No connected LLM found — proceeding anyway (--allow-no-provider)." >&2
  else
    echo "install-webchat: no connected LLM found." >&2
    echo "  Webchat needs at least one usable model. Connect one, then re-run:" >&2
    echo "    • Claude  — run /setup (or set ANTHROPIC_API_KEY in .env)" >&2
    echo "    • Codex   — run /add-codex" >&2
    echo "  Installing the UI first? re-run with --allow-no-provider." >&2
    exit 1
  fi
fi

# ── 0c. better-sqlite3 native-binding verify ──────────────────────────────
# The host's SQLite driver (better-sqlite3) is a NATIVE module compiled for one
# Node ABI (NODE_MODULE_VERSION, which is per-major). Switch Node majors after
# install — common with nvm/fnm/mise or a Homebrew upgrade — and the stale
# binding makes the host crash at BOOT, long before any webchat code runs. This
# preflight loads the binding and, if it's stale, rebuilds it under the project's
# Node (.nvmrc) so the install leaves a host that actually starts. pnpm-native
# (no npm); ABI is per-major so any installed minor of the right major works.
# Idea adapted from Artificer-Innovations/nanoclaw-webchat's `verify`.
SQLITE_VERIFY_FAILED=0

node_major() { node -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null; }

project_node_major() {
  local v=""
  if [ -f .nvmrc ]; then v="$(tr -dc '0-9.' < .nvmrc)"
  elif [ -f .node-version ]; then v="$(tr -dc '0-9.' < .node-version)"; fi
  [ -n "$v" ] && echo "${v%%.*}" || node_major
}

# Echo a bin dir holding `node` for the given major from a version manager
# (nvm / fnm / mise), or nothing. Any minor of the target major is fine — the
# ABI is per-major — so the first match wins.
project_node_bindir() {
  local major="$1" base match sub
  for base in "${NVM_DIR:-$HOME/.nvm}/versions/node" \
              "${FNM_DIR:-$HOME/.local/share/fnm}/node-versions" \
              "$HOME/Library/Application Support/fnm/node-versions" \
              "${MISE_DATA_DIR:-$HOME/.local/share/mise}/installs/node"; do
    [ -d "$base" ] || continue
    match="$(ls -1 "$base" 2>/dev/null | grep -E "^v?${major}\." | sort -r | head -1)"
    [ -n "$match" ] || continue
    for sub in bin installation/bin; do
      [ -x "$base/$match/$sub/node" ] && { echo "$base/$match/$sub"; return 0; }
    done
  done
  return 1
}

verify_native_sqlite() {
  command -v node >/dev/null 2>&1 || { echo "  = node not on PATH — skipping better-sqlite3 verify" >&2; return 0; }
  local pmajor smajor prefix="" bindir
  pmajor="$(project_node_major)"; smajor="$(node_major)"
  if [ -n "$pmajor" ] && [ "$pmajor" != "$smajor" ]; then
    if bindir="$(project_node_bindir "$pmajor")"; then
      prefix="$bindir:"
      echo "  = bridging to Node v$pmajor (shell is on v$smajor)"
    else
      echo "  = shell Node is v$smajor but the project targets v$pmajor (.nvmrc) — run 'nvm use' (or fnm/mise) for the host" >&2
    fi
  fi
  # Open an in-memory DB, don't just require(): better-sqlite3 loads its native
  # binding LAZILY (on first Database open), so a bare require() returns OK even
  # when the .node is ABI-stale/corrupt — a false pass. Opening forces dlopen.
  local probe="new (require('better-sqlite3'))(':memory:').close();process.exit(0)"
  if PATH="${prefix}$PATH" node -e "$probe" >/dev/null 2>&1; then
    echo "  ✓ better-sqlite3 native binding loads (Node v$(PATH="${prefix}$PATH" node_major))"
    return 0
  fi
  echo "  → better-sqlite3 binding stale — rebuilding (pnpm rebuild better-sqlite3) …"
  PATH="${prefix}$PATH" pnpm rebuild better-sqlite3 >/dev/null 2>&1 || true
  if PATH="${prefix}$PATH" node -e "$probe" >/dev/null 2>&1; then
    echo "  ✓ better-sqlite3 rebuilt (Node v$(PATH="${prefix}$PATH" node_major))"
    return 0
  fi
  local bsql; bsql="$(node -e "try{process.stdout.write(require('./package.json').dependencies['better-sqlite3']||'?')}catch(e){process.stdout.write('?')}" 2>/dev/null)"
  echo "" >&2
  echo "  ⚠  better-sqlite3 still won't load — your host will crash at boot until this is fixed." >&2
  echo "     shell Node v$smajor · project Node (.nvmrc) v${pmajor:-?} · better-sqlite3 $bsql" >&2
  echo "     Fix one of:" >&2
  echo "       • run the host under the project Node:  nvm install ${pmajor:-22} && nvm use ${pmajor:-22}   (or fnm/mise)" >&2
  echo "       • Node 26+ needs better-sqlite3 ≥ 12.10.0:  pnpm add better-sqlite3@^12.10.0 && pnpm rebuild better-sqlite3" >&2
  echo "" >&2
  SQLITE_VERIFY_FAILED=1
  return 0  # non-fatal: let the rest of the install finish, but warn loudly at the end
}

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
  src/onecli-preflight.ts
  src/onecli-preflight.test.ts
  src/mcp-server-config.ts
  src/mcp-server-config.test.ts
  src/modules/user-credentials
  src/db/migrations/020-byok-credentials.ts
  src/db/migrations/021-byok-oauth.ts
  src/db/migrations/022-byok-provider.ts
  src/db/migrations/023-byok-user-credentials.ts
  src/db/migrations/024-rename-user-credentials.ts
  setup/get-oauth-token.sh
  docs/design/user-credentials.md
  docs/design/user-credentials-oauth.md
  docs/design/webchat-threads.md
  docs/design/webchat-threads-qa.md
  docs/design/thread-engaged-agents.md
  docs/design/webchat-thread-context-sync.md
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
  src/container-runtime.ts
  src/modules/index.ts
  src/modules/approvals/onecli-approvals.ts
  src/modules/typing/index.ts
  src/modules/typing/index.test.ts
  container/Dockerfile
  container/agent-runner/src/integration.test.ts
  container/agent-runner/src/poll-loop.test.ts
  container/agent-runner/src/upload-trace.test.ts
  container/agent-runner/src/mcp-tools/cli.instructions.md
  src/container-config.ts
  container/agent-runner/src/config.ts
  container/agent-runner/src/index.ts
  src/container-runtime.test.ts
  src/host-sweep.ts
  src/cli/resources/groups.ts
  src/cli/resources/groups.test.ts
  src/db/sessions.ts
  src/modules/agent-to-agent/write-destinations.ts
  src/modules/agent-to-agent/write-destinations.test.ts
  src/modules/self-mod/apply.ts
  src/modules/self-mod/apply.test.ts
  src/modules/approvals/response-handler.test.ts
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

# ── 2d. Provider activity overlays: per-provider webchat enrichment ───────
# Some providers need a small webchat edit (live thinking-bubble activity) that
# can't ride HOOK_FILES: the provider file is skill-installed and absent from
# this branch, so there's no `git diff $BASE $BR` delta to compute. The delta is
# stored as a committed patch on the channel branch and applied here only when
# that provider is installed. Plain `git apply` (NOT --3way): the target is
# untracked (no index entry, which --3way requires) and its base is pinned to
# the provider's installed version. Idempotent via the reverse-check.
# Future providers: add one row + one patch — no code change here.
#   marker_file | patch | extra_src:extra_dest (optional new file to copy)
PROVIDER_OVERLAYS=(
  "container/agent-runner/src/providers/codex.ts|webchat-hooks/codex-activity.patch|webchat-hooks/codex-activity.test.ts:container/agent-runner/src/providers/codex-activity.test.ts"
)
echo "→ Applying provider activity overlays …"
for entry in "${PROVIDER_OVERLAYS[@]}"; do
  IFS='|' read -r marker patch extra <<< "$entry"
  if [ ! -f "$marker" ]; then
    echo "  = ${marker##*/}: provider not installed — skip (run its /add-* skill, then re-run)"
    continue
  fi
  if ! PCONTENT=$(git show "$BR:$patch" 2>/dev/null); then
    echo "  !! ${patch##*/}: not found on $BR — skip" >&2
    continue
  fi
  if echo "$PCONTENT" | git apply --reverse --check 2>/dev/null; then
    echo "  = ${patch##*/}: already applied (skip)"
  elif echo "$PCONTENT" | git apply 2>/dev/null; then
    echo "  → ${patch##*/}: applied"
  else
    CONFLICTS+=("$patch")
    echo "  !! ${patch##*/}: does not apply ($marker drifted from its pinned base) — left unchanged" >&2
  fi
  if [ -n "${extra:-}" ]; then
    IFS=':' read -r esrc edst <<< "$extra"
    if git show "$BR:$esrc" > "$edst" 2>/dev/null; then
      echo "  → ${edst##*/}: installed"
    else
      rm -f "$edst"
      echo "  !! ${esrc##*/}: not found on $BR — skip" >&2
    fi
  fi
done

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

# ── 4a. File-based migrations: register numbered migrations from NEW_PATHS ──
# The barrel pass above only registers `moduleWebchat*` symbols imported from
# `channels/webchat/migration.js`. The user-credentials (and any future)
# migrations ship as their OWN numbered files in src/db/migrations/NNN-*.ts —
# copied via NEW_PATHS, exported as `migrationNNN`, and imported from the file
# itself, NOT the barrel. Without this they get copied + run by nothing → the
# table is missing at first use (e.g. webchat 500s with `no such table:
# user_credentials`). Each is added idempotently: import line + array entry,
# skipping any already present.
FILE_MIGRATIONS=()
for p in "${NEW_PATHS[@]}"; do
  case "$p" in
    src/db/migrations/*.ts) [ -f "$p" ] && FILE_MIGRATIONS+=("$p") ;;
  esac
done
if [ "${#FILE_MIGRATIONS[@]}" -gt 0 ]; then
  TMPFILE2=$(mktemp --suffix=.mjs)
  cat > "$TMPFILE2" <<'NODE_EOF'
import { readFileSync, writeFileSync } from 'node:fs';

// One src/db/migrations/NNN-*.ts path per entry (copied via NEW_PATHS). Their
// array order here is the registration order — matches the channel branch,
// which lists the file migrations last.
const files = process.env.FILE_MIGRATIONS.trim().split(/\s+/);
const target = 'src/db/migrations/index.ts';
let src = readFileSync(target, 'utf8');
let changed = false;
const arrayRe = /(const migrations: Migration\[\] = \[[\s\S]*?)\];/;

for (const file of files) {
  // The exported symbol + its import path come from the migration file itself,
  // so this never drifts from what the file actually exports.
  const body = readFileSync(file, 'utf8');
  const m = body.match(/export (?:const|function) (migration[0-9A-Za-z]+)\b/);
  if (!m) {
    console.error(`  ! ${file}: no exported migration symbol — skipping`);
    continue;
  }
  const sym = m[1];
  const rel = './' + file.replace(/^src\/db\/migrations\//, '').replace(/\.ts$/, '.js');
  const importLine = `import { ${sym} } from '${rel}';`;

  // Import order is irrelevant to behavior, so insert after the first import to
  // stay robust against however the surrounding imports are arranged.
  if (!src.includes(importLine)) {
    src = src.replace(/^(import .*\n)/m, `$1${importLine}\n`);
    changed = true;
  }
  // Array order IS load-bearing (migrations run top-to-bottom); append in the
  // NEW_PATHS order, skipping any symbol already registered.
  const arr = src.match(arrayRe);
  if (arr && !new RegExp(`\\b${sym}\\b`).test(arr[1])) {
    src = src.replace(arrayRe, `$1  ${sym},\n];`);
    changed = true;
  }
}

if (changed) {
  writeFileSync(target, src);
  console.log(`→ Registered ${files.length} file-based migration(s) in ${target}`);
} else {
  console.log('= File-based migrations already registered (skip)');
}
NODE_EOF
  FILE_MIGRATIONS="${FILE_MIGRATIONS[*]}" node "$TMPFILE2"
  rm -f "$TMPFILE2"
fi

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
# @modelcontextprotocol/sdk backs the MCP-server probe (mcp-probe.ts) — the
# same version the agent container pins for its own MCP tooling.
echo "→ Installing webchat dependencies …"
pnpm add ws@8.20.0 busboy@1.6.0 web-push@3.6.7 undici@7.16.0 @modelcontextprotocol/sdk@1.29.0
pnpm add -D @types/ws@8.18.1 @types/busboy@1.5.4 @types/web-push@3.6.4

# ── 5b. Verify the native SQLite binding boots under the project Node ─────
# Runs after `pnpm add` (which can re-touch native modules) so it checks the
# binding the host will actually load at boot. See verify_native_sqlite above.
if [ "$SKIP_SQLITE_VERIFY" != "1" ]; then
  echo "→ Verifying better-sqlite3 native binding …"
  verify_native_sqlite
else
  echo "= Skipping better-sqlite3 verify (SKIP_SQLITE_VERIFY=1)"
fi

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

if [ "$SQLITE_VERIFY_FAILED" = "1" ]; then
  echo "" >&2
  echo "⚠  Webchat files are installed, but better-sqlite3 won't load under your" >&2
  echo "   current Node — the host will NOT boot until you fix it (see the fix" >&2
  echo "   printed above, or re-run after 'nvm use')." >&2
fi

cat <<'DONE'

✓ Webchat installed.

Next: configure environment + auth.
  bash configure-webchat.sh

Or set the .env vars by hand — see .claude/skills/add-webchat/SKILL.md
under "Configure" for the full menu (auth methods, TLS, VAPID).

Built in: secure shared-room user credentials — several people in one room, each
billing their own turns to their own Anthropic API key or Claude subscription.
Off by default; enable it per room from room settings (needs OneCLI: /init-onecli).
DONE
