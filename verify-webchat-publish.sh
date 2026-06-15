#!/usr/bin/env bash
#
# verify-webchat-publish.sh — pre-publish gate for the webchat channel branch.
#
# Run this BEFORE publishing channels-webchat (forgejo → javexed). It catches
# the three classes of mistake that have actually bitten this project:
#   1. drift — a file changed on the channel branch that the installer never
#      delivers (orphans), or a migration that's exported but not registered.
#   2. identity — a commit carrying a private email that GitHub's push-block
#      will reject.
#   3. staleness — your local channel branch differing from the remote tip
#      you're about to publish.
#
#   ./verify-webchat-publish.sh            # fast structural checks
#   ./verify-webchat-publish.sh --full     # also run install→uninstall round-trip
#
# Env overrides: UPSTREAM_REF (default origin/main), CHANNEL_REF
# (default channels-webchat), WEBCHAT_REMOTE (default forgejo),
# BLOCKED_EMAIL (default the maintainer's private gmail).
#
# Exit 0 = safe to publish. Exit 1 = a check failed. Exit 2 = setup error.

set -uo pipefail   # deliberately NOT -e: run every check, collect all failures

UPSTREAM="${UPSTREAM_REF:-origin/main}"
CHANNEL="${CHANNEL_REF:-channels-webchat}"
REMOTE="${WEBCHAT_REMOTE:-forgejo}"
BLOCKED_EMAIL="${BLOCKED_EMAIL:-$(git config user.email)}"
FULL=false
[ "${1:-}" = "--full" ] && FULL=true

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "not in a git checkout" >&2; exit 2; }

FAILS=0
pass()    { echo "  ✓ $1"; }
fail()    { echo "  ✗ $1" >&2; FAILS=$((FAILS + 1)); }
section() { echo; echo "── $1 ──"; }

git rev-parse --verify "$UPSTREAM" >/dev/null 2>&1 || { echo "upstream ref '$UPSTREAM' not found (fetch origin?)" >&2; exit 2; }
git rev-parse --verify "$CHANNEL"  >/dev/null 2>&1 || { echo "channel ref '$CHANNEL' not found" >&2; exit 2; }
BASE=$(git merge-base "$CHANNEL" "$UPSTREAM")
echo "verifying  channel=$CHANNEL ($(git rev-parse --short "$CHANNEL"))  vs upstream=$UPSTREAM ($(git rev-parse --short "$UPSTREAM"))"
echo "fork point: $(git log -1 --oneline "$BASE")"

# ── 1. Freshness ──────────────────────────────────────────────────────────
section "Freshness — local channel ref matches the remote you'll publish"
if git remote get-url "$REMOTE" >/dev/null 2>&1; then
  rtip=$(git ls-remote "$REMOTE" refs/heads/channels-webchat 2>/dev/null | awk '{print $1}')
  ltip=$(git rev-parse "$CHANNEL")
  if   [ -z "$rtip" ];          then fail "could not read $REMOTE channels-webchat tip"
  elif [ "$rtip" = "$ltip" ];   then pass "channel ref == $REMOTE tip ($(echo "$ltip" | cut -c1-9))"
  else fail "STALE: $CHANNEL=$(echo "$ltip" | cut -c1-9) != $REMOTE=$(echo "$rtip" | cut -c1-9) — fetch before publishing"
  fi
else
  echo "  (remote '$REMOTE' not configured — skipping)"
fi

# ── 2. Identity ───────────────────────────────────────────────────────────
section "Identity — no private email in the publish range"
hits=$(git log --format='%ae%n%ce' "$BASE..$CHANNEL" | grep -cxF "$BLOCKED_EMAIL" || true)
if [ "$hits" -eq 0 ]; then pass "no commit exposes $BLOCKED_EMAIL"
else fail "$hits commit(s) carry $BLOCKED_EMAIL — GitHub will reject the push (rewrite email or enable hide_email)"
  git log --format='    %h %ae | %s' "$BASE..$CHANNEL" | grep -F "$BLOCKED_EMAIL" >&2
fi

# ── 3. Completeness ───────────────────────────────────────────────────────
section "Completeness — every changed file is delivered by install-webchat.sh"
INST=$(git show "$CHANNEL:install-webchat.sh" 2>/dev/null || true)
if [ -z "$INST" ]; then fail "no install-webchat.sh on $CHANNEL"; else
  NEWP=$(printf '%s\n' "$INST" | awk '/^NEW_PATHS=\(/{f=1;next} f&&/^\)/{f=0} f{gsub(/^[ \t]+/,"");print}')
  HOOKF=$(printf '%s\n' "$INST" | awk '/^HOOK_FILES=\(/{f=1;next} f&&/^\)/{f=0} f{gsub(/^[ \t]+/,"");print}')
  uncovered=""
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    covered=no
    # copied new dirs/files
    while IFS= read -r d; do [ -z "$d" ] && continue; case "$f" in "$d"|"$d"/*) covered=yes;; esac; done <<< "$NEWP"
    # hooked core files
    while IFS= read -r h; do [ "$f" = "$h" ] && covered=yes; done <<< "$HOOKF"
    # dedicated installer steps + deps + tooling
    case "$f" in
      src/channels/index.ts|src/db/migrations/index.ts) covered=yes ;;             # barrels (steps 3 & 4)
      package.json|pnpm-lock.yaml) covered=yes ;;                                  # deps (step 5)
      install-webchat.sh|uninstall-webchat.sh|configure-webchat.sh|verify-webchat-publish.sh) covered=yes ;;
    esac
    [ "$covered" = no ] && uncovered="${uncovered}${f}"$'\n'
  done < <(git diff --name-only "$BASE" "$CHANNEL")
  total=$(git diff --name-only "$BASE" "$CHANNEL" | grep -c .)
  if [ -z "${uncovered//[$'\n']/}" ]; then pass "all $total changed files are delivered"
  else fail "files changed on $CHANNEL but NOT delivered by the installer (orphans):"
    printf '%s' "$uncovered" | sed '/^$/d; s/^/      /' >&2
  fi
fi

# ── 4. Migration registration ─────────────────────────────────────────────
section "Migrations — every exported moduleWebchat* is registered"
EXP=$(git show "$CHANNEL:src/channels/webchat/migration.ts" 2>/dev/null | grep -oE 'export const moduleWebchat[A-Za-z0-9]*' | awk '{print $3}' | sort -u)
REG=$(git show "$CHANNEL:src/db/migrations/index.ts" 2>/dev/null | sed -n '/const migrations: Migration\[\] = \[/,/\];/p' | grep -oE 'moduleWebchat[A-Za-z0-9]*' | sort -u)
if [ -z "$EXP" ]; then fail "no moduleWebchat* exports found in migration.ts"; else
  missing=$(comm -23 <(printf '%s\n' "$EXP") <(printf '%s\n' "$REG"))
  if [ -z "$missing" ]; then pass "all $(printf '%s\n' "$EXP" | grep -c .) webchat migrations are registered in index.ts"
  else fail "exported but NOT registered (would never run on fresh installs):"; printf '%s\n' "$missing" | sed 's/^/      /' >&2
  fi
fi

# ── 5. (--full) install → uninstall round-trip ────────────────────────────
if $FULL; then
  section "Round-trip — install then uninstall returns a clean tree"
  if ! git rev-parse --verify "$REMOTE/channels-webchat" >/dev/null 2>&1; then
    fail "need $REMOTE/channels-webchat fetched for the round-trip (run: git fetch $REMOTE channels-webchat)"
  else
    WT=$(mktemp -d); git worktree add -q --detach "$WT" "$UPSTREAM" 2>/dev/null
    ln -sfn "$(git rev-parse --show-toplevel)/node_modules" "$WT/node_modules"
    git show "$CHANNEL:install-webchat.sh"   > "$WT/install-webchat.sh"
    git show "$CHANNEL:uninstall-webchat.sh" > "$WT/uninstall-webchat.sh"
    FAKE=$(mktemp -d); printf '#!/bin/sh\nexit 0\n' > "$FAKE/pnpm"; chmod +x "$FAKE/pnpm"
    (
      cd "$WT"
      PATH="$FAKE:$PATH" WEBCHAT_REMOTE="$REMOTE" SKIP_CONTAINER_BUILD=1 bash install-webchat.sh >/tmp/vwp-install.log 2>&1
      applied=$([ -f src/channels/webchat/server.ts ] && echo yes || echo no)
      PATH="$FAKE:$PATH" WEBCHAT_REMOTE="$REMOTE" SKIP_CONTAINER_BUILD=1 bash uninstall-webchat.sh >/tmp/vwp-uninstall.log 2>&1
      dirty=$(git status --porcelain | grep -vE 'install-webchat.sh|uninstall-webchat.sh|node_modules' | grep -c .)
      echo "$applied $dirty" > /tmp/vwp-result
    )
    read -r applied dirty < /tmp/vwp-result
    [ "$applied" = yes ] && pass "install applied the webchat module" || fail "install did NOT apply (see /tmp/vwp-install.log)"
    [ "$dirty" -eq 0 ]   && pass "uninstall returned the tree to pristine (0 residual changes)" || fail "uninstall left $dirty residual change(s) — not fully reversible"
    git worktree remove --force "$WT" 2>/dev/null; rm -rf "$FAKE"
  fi
fi

# ── Result ────────────────────────────────────────────────────────────────
section "Result"
if [ "$FAILS" -eq 0 ]; then echo "  ✓ ALL CHECKS PASSED — safe to publish $CHANNEL"; exit 0
else echo "  ✗ $FAILS check(s) failed — DO NOT publish until resolved" >&2; exit 1
fi
