# Publishing webchat updates (maintainer flow)

This is the flow for **shipping changes** to the webchat skill — from wherever
you review them out to your public mirror. You do **not** need this to install
webchat; see [SKILL.md](SKILL.md) for that.

It assumes a two-remote setup: a **review remote** where changes are proposed
and merged first, and a **public mirror** (e.g. GitHub) that the skill is
installed from. If you only have one remote, treat them as the same and skip
the mirror step. Throughout, `<review-remote>` and `<public-remote>` are your
git remote names.

The two branches that get published:

- **`channels-webchat`** — the channel source + installer tooling
- **`skill/webchat`** — these docs

Both should be rebased on current upstream so the skill stays installable on a
clean `nanoco/nanoclaw` checkout.

> **Secure shared-room BYOK is folded into webchat** (the former standalone
> `/add-byok` skill is retired). Its code rides `channels-webchat`
> (`src/modules/byok/`, migrations 020–023, the credentials UI, `oauth-mint.ts`,
> `get-oauth-token.sh`) and its docs ride `skill/webchat`. So it publishes as
> part of this one pair — there is no separate byok publish. Because byok
> handles live credentials, review the byok delta and run the byok tests as part
> of step 3, and confirm `verify-webchat-publish.sh` covers the byok files
> (they're in `install-webchat.sh`'s `NEW_PATHS`/`HOOK_FILES` and the hook
> allowlist).

## The flow

### 1. Review + merge (review gate)

All changes land as PRs against `channels-webchat` / `skill/webchat` on your
**review remote first**, and are reviewed/merged there. The review remote is the
source of truth; the public mirror is downstream. Never push to the mirror
before the change is reviewed.

### 2. Run the pre-publish verifier (hard gate)

```bash
git fetch <review-remote> channels-webchat
git checkout <review-remote>/channels-webchat -- verify-webchat-publish.sh
WEBCHAT_REMOTE=<review-remote> ./verify-webchat-publish.sh --full
```

It must exit `0`. It checks the failure classes that a diff review does **not**
reliably catch:

- **Freshness** — your local channel ref matches the remote tip you're about to
  publish (guards against publishing a stale branch).
- **Identity** — no commit carries a private email (GitHub's push-block rejects
  those; see step 5).
- **Completeness** — every file changed on `channels-webchat` is actually
  delivered by `install-webchat.sh` (no orphans that ship on the branch but
  never install).
- **Migrations** — every exported `moduleWebchat*` is registered.
- **`--full`** — `install-webchat.sh` → `uninstall-webchat.sh` round-trips to a
  pristine tree.

If it reports failures, fix them on the review remote (back to step 1) and
re-run. **Do not publish on a red verifier.**

### 3. Semantic review

The verifier catches structural drift; it does not judge logic. Run a review
pass on the merged delta — e.g. `/code-review ultra <PR#>` for the cloud
multi-agent pass — paying attention to anything the verifier can't see, such as
merge-conflict resolutions where upstream and webchat both changed a file.

### 4. Runtime smoke test

A green build is **not** "done." Actually run it: install webchat onto a clean
upstream checkout, start the host, and confirm the adapter comes up
(`Webchat HTTP listening` in the log, the port answers). For container-affecting
changes, spawn a session and have the agent run a command. (`/verify` automates
this.) This is the step that catches a change that compiles but breaks at
runtime.

### 5. Publish to the mirror

Only after 1–4 pass, and with explicit go-ahead:

```bash
# Back up the current mirror tips first (recoverability)
git tag backup/channels-webchat-pre-publish <public-remote>/channels-webchat
git tag backup/skill-webchat-pre-publish    <public-remote>/skill/webchat
git push <public-remote> backup/channels-webchat-pre-publish backup/skill-webchat-pre-publish

# Force-push the rebased branches
git push <public-remote> <review-remote>/channels-webchat:refs/heads/channels-webchat \
  --force-with-lease=channels-webchat:<mirror-tip>
git push <public-remote> <review-remote>/skill/webchat:refs/heads/skill/webchat \
  --force-with-lease=skill/webchat:<mirror-tip>
```

(These are history-rewriting force-pushes because the branches are rebased on
upstream — tag a backup first and use `--force-with-lease`.)

#### Email privacy

If your review remote's web-UI merges stamp commits with your **real** email,
GitHub's *"Block command line pushes that expose my email"* setting will reject
the push to the mirror. Two defenses:

1. Enable the review remote's "keep email address private" setting so its web
   merges use a noreply form (prevents recurrence).
2. The verifier's **Identity** check (step 2) flags any commit carrying a real
   email before you push. If one slips through, rewrite the offending commits to
   the `@users.noreply.github.com` form and re-push **both** remotes so they
   stay in sync.

## Summary

```
PR on review remote → review/merge        (step 1)
   ↓
./verify-webchat-publish.sh --full  must exit 0   (step 2)
   ↓
semantic review (/code-review ultra)      (step 3)
   ↓
runtime smoke test                        (step 4)
   ↓
backup tags + force-push to the mirror    (step 5)
```
