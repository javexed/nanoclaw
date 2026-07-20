#!/usr/bin/env bash
# Sync the fork-owned Codex payload branch (providers-codex) with upstream.
#
# WHY: /add-codex copies the Codex provider payload `from-branch:providers-codex`.
# That branch is this fork's own source: upstream's `providers` tip plus a small
# carried patch (the MCP-union writer fix — Codex's config.toml can't express this
# fork's remote sse/http MCP servers, so the writer skips them). It must stay
# current with upstream while keeping our patch.
#
# MODEL: rebase-carry. Our commit(s) ride ON TOP of upstream. Syncing rebases them
# onto the new upstream tip and force-pushes. That's safe: /add-codex reads only
# the branch tip (it copies files, ignores history), so rewriting history is fine.
#
# USAGE:
#   scripts/sync-providers-codex.sh --check   # report drift only, no writes
#   scripts/sync-providers-codex.sh           # rebase our patch onto upstream + push
#
# ENV: UPSTREAM_REMOTE (default origin), FORK_REMOTE (default forgejo).
set -euo pipefail

UPSTREAM="${UPSTREAM_REMOTE:-origin}"
FORK="${FORK_REMOTE:-forgejo}"
UP_BRANCH="providers"
FORK_BRANCH="providers-codex"
# Paths the Codex payload lives under — used only to summarise upstream changes.
CODEX_PATHS=(container/agent-runner/src/providers src/providers setup/providers container/AGENTS.md)

say() { printf '%s\n' "$*" >&2; }

# 1. Refresh upstream (deepen a shallow clone, else fetch/rebase/push break).
if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
  say "Shallow clone — deepening ${UPSTREAM}/${UP_BRANCH}…"
  git fetch "$UPSTREAM" "$UP_BRANCH" --unshallow 2>/dev/null \
    || git fetch "$UPSTREAM" "$UP_BRANCH" --depth=1000000
else
  git fetch "$UPSTREAM" "$UP_BRANCH"
fi
# --unshallow can leave the remote-tracking ref behind; pin it to what we fetched.
git update-ref "refs/remotes/${UPSTREAM}/${UP_BRANCH}" FETCH_HEAD
git fetch "$FORK" "$FORK_BRANCH"

UP_TIP="$(git rev-parse "${UPSTREAM}/${UP_BRANCH}")"
FORK_TIP="$(git rev-parse "${FORK}/${FORK_BRANCH}")"
BASE="$(git merge-base "$FORK_TIP" "$UP_TIP")"   # last upstream commit our patch sits on

say ""
say "Carried patch(es) on ${FORK}/${FORK_BRANCH}:"
git --no-pager log --oneline "${UP_TIP}..${FORK_TIP}" >&2 || true

if [ "$BASE" = "$UP_TIP" ]; then
  say ""
  say "✓ Up to date — ${FORK}/${FORK_BRANCH} already sits on the current upstream tip ($(git rev-parse --short "$UP_TIP"))."
  exit 0
fi

say ""
say "⇪ Upstream advanced $(git rev-list --count "${BASE}..${UP_TIP}") commit(s). Changes touching the Codex payload:"
git --no-pager diff --stat "${BASE}..${UP_TIP}" -- "${CODEX_PATHS[@]}" >&2 || say "  (none — payload files unchanged upstream; rebase should be clean)"

if [ "${1:-}" = "--check" ]; then
  say ""
  say "(--check) Not syncing. Re-run without --check to rebase our patch onto upstream and push."
  exit 0
fi

# 2. Rebase our carried patch onto the new upstream tip, in a throwaway worktree.
WT="$(mktemp -d)"
cleanup() { git worktree remove --force "$WT" 2>/dev/null || true; }
trap cleanup EXIT
git worktree add -q --detach "$WT" "$FORK_TIP"
if ! git -C "$WT" rebase "$UP_TIP"; then
  say ""
  say "✗ Rebase conflict — upstream edited code our patch touches. Resolve it:"
  say "    cd '$WT' && git status        # fix conflicts, then:"
  say "    git rebase --continue"
  say "    SKIP_PR_PREFLIGHT=1 git push --force-with-lease ${FORK} HEAD:${FORK_BRANCH}"
  say "  (leaving the worktree at $WT for you)"
  trap - EXIT
  exit 1
fi
SKIP_PR_PREFLIGHT=1 git -C "$WT" push --force-with-lease "$FORK" "HEAD:${FORK_BRANCH}"
say ""
say "✓ Synced: rebased our patch onto ${UPSTREAM}/${UP_BRANCH} ($(git rev-parse --short "$UP_TIP")) and force-pushed ${FORK}/${FORK_BRANCH}."
say "  Re-run /add-codex (or ncl reinstall) to pull the refreshed payload."
