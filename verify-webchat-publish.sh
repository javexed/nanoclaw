#!/usr/bin/env bash
#
# verify-webchat-publish.sh — pre-publish gate for the webchat channel branch.
#
# Run this BEFORE publishing the channels-webchat branch to your remote. It
# catches the classes of mistake that have actually bitten this skill:
#   1. drift — a file changed on the channel branch that the installer never
#      delivers (orphans), or a migration that's exported but not registered.
#   2. identity — a commit carrying a private email that GitHub's push-block
#      will reject.
#   3. staleness — your local channel branch differing from the remote tip
#      you're about to publish.
#   4. exposure — a private email or secret token hardcoded in FILE CONTENT.
#      The commit-author check (2) MISSES this — scanning file content is how we
#      ensure a maintainer's personal email isn't leaked via a file body.
#      ALWAYS scan file content, not just commit metadata.
#
#   ./verify-webchat-publish.sh            # fast structural checks
#   ./verify-webchat-publish.sh --full     # also run install→uninstall round-trip
#
# Env overrides: UPSTREAM_REF (default origin/main), CHANNEL_REF
# (default channels-webchat), WEBCHAT_REMOTE (the remote you publish to,
# default origin), BLOCKED_EMAIL (optional; see below — never hardcode it here).
#
# Exit 0 = safe to publish. Exit 1 = a check failed. Exit 2 = setup error.

set -uo pipefail   # deliberately NOT -e: run every check, collect all failures

UPSTREAM="${UPSTREAM_REF:-origin/main}"
CHANNEL="${CHANNEL_REF:-channels-webchat}"
REMOTE="${WEBCHAT_REMOTE:-origin}"
# Private email to block in commit authorship. NEVER hardcode it here — that
# would re-introduce the exact leak this script guards against. Supply it via
# the BLOCKED_EMAIL env var, or a gitignored `.git/publish-blocked-email` file
# (one-time: echo you@private.example > "$(git rev-parse --git-dir)/publish-blocked-email").
# Unset → the author-email check is skipped (GitHub's own push-block + the
# file-content Exposure scan below remain as backstops).
BLOCKED_EMAIL="${BLOCKED_EMAIL:-$(cat "$(git rev-parse --git-dir 2>/dev/null)/publish-blocked-email" 2>/dev/null || true)}"
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
if [ -z "$BLOCKED_EMAIL" ]; then
  echo "  (BLOCKED_EMAIL not set — skipping the private-email author check. Set the env"
  echo "   var or .git/publish-blocked-email to your private email to enable it.)"
else
  hits=$(git log --format='%ae%n%ce' "$BASE..$CHANNEL" | grep -cxF "$BLOCKED_EMAIL" || true)
  if [ "$hits" -eq 0 ]; then pass "no commit exposes $BLOCKED_EMAIL"
  else fail "$hits commit(s) carry $BLOCKED_EMAIL — GitHub will reject the push (rewrite email or enable hide_email)"
    git log --format='    %h %ae | %s' "$BASE..$CHANNEL" | grep -F "$BLOCKED_EMAIL" >&2
  fi
fi

# ── 2b. Exposure — no private email or secret token in FILE CONTENT ────────
# The author-email check above is blind to anything embedded INSIDE a file, so
# this scans content to ensure a maintainer's personal email isn't leaked that way.
section "Exposure — no private email / secret material in published file content"
# (a) Any PERSONAL-PROVIDER email newly added to file content — the real PII
#     risk. Targeting known personal providers (not all domains) keeps it quiet
#     on fixture addresses like foo@alice.com while hard-failing on a real
#     gmail/outlook/etc. Doesn't need the address known up front.
EMAIL_RE='[A-Za-z0-9._%+-]+@(gmail|googlemail|outlook|hotmail|live|yahoo|ymail|icloud|proton|protonmail|aol|gmx)\.[A-Za-z.]+'
emc=$(git diff "$BASE" "$CHANNEL" -- . ':!*.test.ts' ':!*.md' 2>/dev/null \
        | grep -E '^\+' | grep -vE '^\+\+\+' | grep -oiE "$EMAIL_RE" | sort -u || true)
if [ -z "$emc" ]; then pass "no personal-provider email added to file content"
else fail "personal email(s) in added file content — scrub before publishing:"
  printf '%s\n' "$emc" | sed 's/^/      /' >&2
fi
# (a2) If a specific private email is configured, hard-check the WHOLE tree for it.
if [ -n "$BLOCKED_EMAIL" ]; then
  em=$(git grep -nI -F "$BLOCKED_EMAIL" "$CHANNEL" -- . 2>/dev/null || true)
  if [ -z "$em" ]; then pass "configured private email absent from all file content"
  else fail "configured private email found in file content:"; printf '%s\n' "$em" | sed 's/^/      /' >&2; fi
fi
# (b) Secret-shaped tokens newly added on the channel branch. Test fixtures,
#     doc examples, and the redaction pattern table are legitimately full of
#     fake tokens, so exclude them; anything left is a real-secret candidate.
SECRET_RE='sk-ant-(api03|oat01)-[A-Za-z0-9_-]{50,}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}|xox[bpas]-[0-9]{8,}-[0-9]{8,}-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
sec=$(git diff "$BASE" "$CHANNEL" -- . ':!*.test.ts' ':!*redact.ts' ':!*.md' 2>/dev/null \
        | grep -E '^\+' | grep -vE '^\+\+\+' \
        | grep -EI "$SECRET_RE" | grep -vE 'repeat\(|A\{30,\}|a\{30,\}' || true)
if [ -z "$sec" ]; then pass "no secret-shaped tokens added (outside tests/docs/redact patterns)"
else fail "possible REAL secret(s) added on $CHANNEL — review before publishing:"
  printf '%s\n' "$sec" | sed 's/^/      /' >&2
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
      e2e/*|playwright.config.ts) covered=yes ;;                                   # dev-only e2e infra — intentionally not installed
      webchat-hooks/*) covered=yes ;;                                              # provider overlays (step 2d) — applied/copied by name
      README.md|README_ja.md|README_ko.md|README_zh.md|CHANGELOG.md|CONTRIBUTING.md) covered=yes ;; # root project docs (all languages) — repo documentation; the overlay never patches them
      .claude/skills/*|docs/*) covered=yes ;;                                       # repo-resident skills + ALL docs — repo documentation, not delivered by the webchat overlay
      .github/*|repo-tokens/*) covered=yes ;;                                       # CI workflows + README badge assets — repo infra, never installed onto a user tree
      templates/*) covered=yes ;;                                                   # repo-resident agent templates + their docs — carried by the base install, not the webchat overlay
      setup/*) covered=yes ;;                                                       # base install/setup scripts (e.g. the headless setup:auto fix) — delivered by the base install / release tarball; webchat's own setup/get-oauth-token.sh is separately in NEW_PATHS
      deploy/*) covered=yes ;;                                                     # host-agnostic installer (VM/Pi/bare metal) — repo-resident tooling run FROM the repo, never delivered by the webchat overlay
      src/cli/*|container/agent-runner/src/cli/*) covered=yes ;;                    # base ncl admin CLI (host + container) — a base feature with zero webchat references; reaches installs via the base tree / release tarball, not the overlay
      .husky/*) covered=yes ;;                                                     # git-hook dev tooling (staged-scope prettier fix, pre-push) — repo infra like .github/*, never installed onto a user tree
      scripts/*) covered=yes ;;                                                    # repo tooling run FROM the repo: skill-apply engine (base tree / release tarball, like setup/*) + fork dev scripts (pr-preflight, sync-providers-codex); never delivered by the overlay
      versions.json) covered=yes ;;                                                # base-install version pins (onecli gateway/CLI) consumed by setup — base tree, not the overlay; fork carries the 1.37.0 credential_not_found fix
      src/templates/create-agent.test.ts) covered=yes ;;                           # CI-stability timeout headroom on a base test (forgejo runner starves the 5s default under the full suite) — repo test infra, not delivered by the overlay
    esac
    [ "$covered" = no ] && uncovered="${uncovered}${f}"$'\n'
  done < <(git diff --name-only "$BASE" "$CHANNEL")
  total=$(git diff --name-only "$BASE" "$CHANNEL" | grep -c .)
  if [ -z "${uncovered//[$'\n']/}" ]; then pass "all $total changed files are delivered"
  else fail "files changed on $CHANNEL but NOT delivered by the installer (orphans):"
    printf '%s' "$uncovered" | sed '/^$/d; s/^/      /' >&2
  fi
fi

# ── 3b. Hook surface ───────────────────────────────────────────────────────
# Completeness (§3) proves every changed file is DECLARED in the installer — but
# a maintainer can silence an orphan failure by simply adding ANY file to
# HOOK_FILES, laundering a non-webchat file (a sibling skill, a provider module,
# unrelated core work) into "delivered" status with no check that it belongs to
# webchat. This pins the core-hook footprint: HOOK_FILES may only name files on
# the blessed allowlist below. When webchat legitimately needs a NEW core hook,
# add it here in the same change — that one-line edit is the conscious review gate.
section "Hook surface — declared core hooks are on the blessed allowlist"
WEBCHAT_HOOK_ALLOWLIST=(
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
  container/Dockerfile
  container/agent-runner/src/integration.test.ts
  container/agent-runner/src/poll-loop.test.ts
  container/agent-runner/src/upload-trace.test.ts
  container/agent-runner/src/mcp-tools/cli.instructions.md
  src/modules/typing/index.ts
  src/modules/typing/index.test.ts
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
  src/db/container-configs.ts
  container/agent-runner/src/mcp-tools/index.ts
  container/agent-runner/src/formatter.ts
  # Security batch + rtk + MCP-hardening hooks (2026-07 cycle):
  container/agent-runner/src/formatter.test.ts
  src/backfill-container-configs.ts
  src/container-runner.test.ts
  src/egress-lockdown.ts
  src/group-init.ts
  container/agent-runner/src/mcp-tools/server.ts
  container/agent-runner/src/mcp-tools/core.instructions.md
  # Drift-reduction pass (2026-07, docs/webchat/upstream-drift.md):
  # eslint.config.js — carries ONLY the public/webchat lint block; eslint flat
  # config has a single entry point, so a fork-only file can't hold the block
  # without still diverging the entry point. host-sweep.test.ts — test rider
  # for the already-blessed src/host-sweep.ts hook (selfHealBloatedContinuation).
  eslint.config.js
  src/host-sweep.test.ts
)
DECLARED=$(git show "$CHANNEL:install-webchat.sh" 2>/dev/null \
  | awk '/^HOOK_FILES=\(/{f=1;next} f&&/^\)/{f=0} f{gsub(/^[ \t]+/,"");print}')
if [ -z "$DECLARED" ]; then fail "no HOOK_FILES found in install-webchat.sh on $CHANNEL"; else
  unblessed=""
  while IFS= read -r h; do
    [ -z "$h" ] && continue
    ok=no
    for a in "${WEBCHAT_HOOK_ALLOWLIST[@]}"; do [ "$h" = "$a" ] && ok=yes && break; done
    [ "$ok" = no ] && unblessed="${unblessed}${h}"$'\n'
  done <<< "$DECLARED"
  hookn=$(printf '%s\n' "$DECLARED" | grep -c .)
  if [ -z "${unblessed//[$'\n']/}" ]; then pass "all $hookn declared hooks are on the blessed allowlist"
  else fail "HOOK_FILES names core file(s) NOT on the webchat hook allowlist — confirm each is a"
    echo "    legitimate webchat hook into shared core (not a sibling skill/provider file slipping" >&2
    echo "    in), then add it to WEBCHAT_HOOK_ALLOWLIST in verify-webchat-publish.sh:" >&2
    printf '%s' "$unblessed" | sed '/^$/d; s/^/      /' >&2
  fi
  # Stale entries (allowlisted but no longer hooked) — informational, non-failing:
  # keeps the list from rotting without blocking a publish that shrinks the surface.
  for a in "${WEBCHAT_HOOK_ALLOWLIST[@]}"; do
    printf '%s\n' "$DECLARED" | grep -qxF "$a" || echo "  · note: allowlisted but no longer a hook — $a (safe to prune)"
  done
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

# ── 4b. E2E smoke — optional browser tier ──────────────────────────────────
# Runs the Playwright suite (e2e/ — happy path + the six-flow smoke spec)
# against the WORKING TREE when @playwright/test and its chromium build are
# both present. Hosts without playwright skip this section and the gate still
# passes — the suite is a dev-only tier, deliberately not per-PR CI (the
# runner is disk-constrained). See docs/webchat/e2e.md.
section "E2E smoke — Playwright browser flows (optional)"
if [ ! -e node_modules/@playwright/test/package.json ]; then
  echo "  - SKIP: @playwright/test not installed (dev-only; see docs/webchat/e2e.md)"
elif ! compgen -G "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}/chromium*" >/dev/null; then
  echo "  - SKIP: chromium browser not installed (pnpm exec playwright install chromium)"
else
  if pnpm run test:e2e >/tmp/vwp-e2e.log 2>&1; then
    pass "playwright suite green ($(grep -oE '[0-9]+ passed' /tmp/vwp-e2e.log | tail -1 || echo 'all'))"
  else
    fail "playwright suite FAILED (see /tmp/vwp-e2e.log)"
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
