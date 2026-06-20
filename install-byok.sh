#!/usr/bin/env bash
#
# install-byok.sh — deterministic installer for secure shared-room BYOK
# (per-member sessions: each person's turn runs under their own OneCLI agent
# identity, so the gateway injects THEIR Anthropic key; the agent still sees
# the full shared transcript). Keys live in the OneCLI vault — no custom crypto.
#
#   git checkout <remote>/skill/byok -- install-byok.sh
#   ./install-byok.sh
#
# DEPENDS ON WEBCHAT + OneCLI. Idempotent. Adds no npm deps and touches no
# agent-runner code, so there is NO container image rebuild. Does NOT touch .env.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)" \
  || { echo "install-byok: must be run inside a nanoclaw git checkout" >&2; exit 1; }

# ── 1. Require webchat (BYOK hooks webchat-owned files) ───────────────────
if [ ! -f src/channels/webchat/server.ts ]; then
  echo "install-byok: webchat is not installed — install /add-webchat first." >&2
  exit 1
fi

# ── 2. Detect the remote carrying the skill/byok branch ───────────────────
if [ -z "${BYOK_REMOTE:-}" ]; then
  BYOK_REMOTE=$(git branch -r | grep -E '/skill/byok$' | awk -F/ '{print $1}' | sort -u | head -1 | xargs)
fi
[ -n "$BYOK_REMOTE" ] || { echo "install-byok: no remote carries a 'skill/byok' branch (set BYOK_REMOTE=)" >&2; exit 1; }
echo "→ Using remote: $BYOK_REMOTE"

# ── 3. Fetch skill/byok + its channels-webchat fork point ─────────────────
git fetch "$BYOK_REMOTE" skill/byok channels-webchat
BR="$BYOK_REMOTE/skill/byok"
BASE=$(git merge-base "$BR" "$BYOK_REMOTE/channels-webchat")
[ -n "$BASE" ] || { echo "install-byok: could not find byok⇄channels-webchat fork point" >&2; exit 1; }
# Refuse if the remote's channels-webchat lags the fork point (would absorb
# non-BYOK webchat work into the delta).
if [ "$BASE" != "$(git rev-parse "$BYOK_REMOTE/channels-webchat")" ]; then
  echo "install-byok: $BYOK_REMOTE/channels-webchat is behind the byok fork point — fetch/advance it first." >&2
  exit 1
fi

# ── 4. BYOK-owned NEW files: copy in wholesale ────────────────────────────
NEW_PATHS=(
  src/modules/byok
  src/db/migrations/020-byok-credentials.ts
  src/db/migrations/021-byok-oauth.ts
)
echo "→ Copying BYOK-owned files …"
git checkout "$BR" -- "${NEW_PATHS[@]}"

# ── 5. Core/webchat hooks: guarded, reversible 3-way patch ────────────────
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
CONFLICTS=()
echo "→ Applying BYOK hooks …"
for f in "${HOOK_FILES[@]}"; do
  PATCH=$(mktemp)
  git diff "$BASE" "$BR" -- "$f" > "$PATCH"
  if [ ! -s "$PATCH" ]; then
    echo "  = $f: no BYOK delta (skip)"
  elif git apply --reverse --check "$PATCH" 2>/dev/null; then
    echo "  = $f: hook already applied (skip)"
  else
    cp "$f" "$PATCH.bak"
    if git apply --3way "$PATCH" 2>/dev/null; then
      rm -f "$PATCH.bak"
      echo "  → $f: hook applied"
    else
      git reset -q -- "$f" 2>/dev/null || true
      cp "$PATCH.bak" "$f"
      rm -f "$PATCH.bak"
      CONFLICTS+=("$f")
      echo "  !! $f: BYOK hook conflicts with your version — left unchanged" >&2
    fi
  fi
  rm -f "$PATCH"
done

git reset -q -- "${NEW_PATHS[@]}" "${HOOK_FILES[@]}" 2>/dev/null || true

if [ "${#CONFLICTS[@]}" -gt 0 ]; then
  echo "" >&2
  echo "⚠  ${#CONFLICTS[@]} BYOK hook(s) could not auto-apply:" >&2
  for f in "${CONFLICTS[@]}"; do echo "     - $f" >&2; done
  echo "   Reconcile (rebase $BR onto your trunk for them) and re-run." >&2
fi

echo "→ Building host (tsc) …"
pnpm run build

cat <<'DONE'

✓ Secure shared-room BYOK installed (per-member sessions).

How it works (secure by default — rooms start 'disabled'):
  • Per room (owner/admin): Room settings → Personal API keys (BYOK):
       disabled  — one shared agent for the room (default)
       optional  — members may connect their own key; others use the shared key
       required  — every member must connect their own key
  • Each member: the in-room banner → "Connect your key" (stored in the OneCLI
    vault; their turns then run under their own OneCLI identity).

Each member's turn runs in its own container under their identity — no shared
per-turn token, nothing to replay. The agent still sees the full transcript.
No npm deps, no agent-runner change → no container rebuild.

To uninstall: bash uninstall-byok.sh
DONE
