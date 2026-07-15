# Releasing NanoClaw (javexed fork)

> **Fork-specific.** The repo's top-level `RELEASING.md` describes the *upstream*
> policy (releases from `main` on `package.json` bumps). This supplements it for
> the **javexed fork**, whose webchat / wizard / deploy features live on
> `channels-webchat`, not `main`. It lives under `deploy/` on purpose — a
> fork-only path that never conflicts when `channels-webchat` merges upstream.

`main` is kept as a faithful mirror of upstream `nanocoai/nanoclaw` so the fork
stays easy to sync. **Releases are cut from `channels-webchat` — never from
`main`.**

Why it matters: the self-host installer and the community-scripts install both
resolve a **GitHub release** — `fetch_and_deploy_gh_release` pulls the latest
release tarball, and NanoClaw's in-app `Update` compares against the newest
release tag. A GitHub release is tied to a **tag**, and a tag can point at any
branch's commit — so releasing off `channels-webchat` needs no change to `main`.

## Cutting a release

### 1. Get `channels-webchat` to the release state

Merge the feature PRs you want included into `channels-webchat`.

### 2. Cut the release (targets the branch)

Match the tag to `package.json`'s `version` so the app version and the release
tag stay aligned:

```bash
gh release create v<VERSION> \
  --repo javexed/nanoclaw \
  --target channels-webchat \
  --title "NanoClaw v<VERSION>" \
  --generate-notes
```

`--target channels-webchat` creates the tag at that branch's HEAD. `main` is
untouched.

### 3. Verify the installer can find it

```bash
gh api repos/javexed/nanoclaw/releases/latest --jq .tag_name   # → v<VERSION>
curl -sI https://github.com/javexed/nanoclaw/archive/refs/tags/v<VERSION>.tar.gz | head -1  # → 302/200
```

### 4. Point the community-scripts catalog logo at the tag (immutable)

In the community-scripts (ProxmoxVED) entry's `json/nanoclaw.json`, set the logo
to the tag rather than a moving branch:

```json
"logo": "https://raw.githubusercontent.com/javexed/nanoclaw/v<VERSION>/public/webchat/icon-512.png"
```

## Notes

- `gh` must be authenticated (`gh auth status`).
- Keep the git tag `== package.json` `version`, so NanoClaw's own version and the
  update check don't drift.
- **Never release from `main`** — it stays a clean mirror of upstream
  `nanocoai/nanoclaw` for painless syncing.
