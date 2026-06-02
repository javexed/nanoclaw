# Remove Webchat

The install ships a matching `uninstall-webchat.sh` on the `channels-webchat`
branch. It is the exact reverse of `install-webchat.sh` and is idempotent —
safe to run even on a partially-installed tree.

## 1. Stop the host

```bash
# macOS
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist

# Linux
systemctl --user stop nanoclaw
```

## 2. Run the uninstaller

```bash
# Detect the remote that carries the webchat branches (same as install)
WEBCHAT_REMOTE=$(git branch -r | grep -E '/skill/webchat$' | awk -F'/' '{print $1}' | sort -u | head -1 | xargs)
git checkout "$WEBCHAT_REMOTE/channels-webchat" -- uninstall-webchat.sh
WEBCHAT_REMOTE="$WEBCHAT_REMOTE" ./uninstall-webchat.sh
```

This:

- **Reverses the core-file hooks** (`index.ts`, `router.ts`, `delivery.ts`, `channels/adapter.ts`, `agent-to-agent/create-agent.ts`, `cli/resources/destinations.ts`, `agent-runner/destinations.ts`) by applying each webchat delta in reverse. A hook that isn't currently applied is skipped, so the file returns exactly to your pre-webchat version.
- **Removes the webchat-owned files** — `src/channels/webchat/`, `public/webchat/`, and the new test files (`create-agent.test.ts`, `session-teardown.ts`/`.test.ts`, `router.agent-loopback.test.ts`, `router.backtick-escape.test.ts`).
- **Unwires the channels barrel** (removes the `import './webchat/index.js';` line) and **unregisters the migrations** (drops the import block + the seven `moduleWebchat*` symbols from `src/db/migrations/index.ts`).
- Runs `pnpm remove` for the webchat deps, `pnpm run build`, and rebuilds the agent container image.

Skip the container rebuild (e.g. in CI) with `SKIP_CONTAINER_BUILD=1`.

After it finishes, `git status` shows the reversal as a clean working-tree
diff — install→uninstall is a verified no-op on tracked files.

## 3. Restart the host

```bash
# macOS
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# Linux
systemctl --user start nanoclaw
```

---

## What the uninstaller intentionally leaves

These are **not** removed automatically — they're either data you may want to
keep or config that's cheap to leave. Clean them up by hand for a total wipe.

### `.env` entries

```
WEBCHAT_ENABLED
WEBCHAT_HOST
WEBCHAT_PORT
WEBCHAT_TOKEN
WEBCHAT_TAILSCALE
WEBCHAT_TRUSTED_PROXY_IPS
WEBCHAT_TRUSTED_PROXY_HEADER
WEBCHAT_TLS_CERT
WEBCHAT_TLS_KEY
WEBCHAT_VAPID_PUBLIC_KEY
WEBCHAT_VAPID_PRIVATE_KEY
WEBCHAT_VAPID_SUBJECT
WEBCHAT_PUBLIC_DIR
```

Just setting `WEBCHAT_ENABLED=false` quietly disables the channel without
removing anything — a lighter alternative to a full uninstall.

### Central-DB tables

The migrations already ran; uninstall only unregisters them so they don't
re-run on a fresh DB. Each migration's `up()` is idempotent
(`CREATE TABLE IF NOT EXISTS`), so re-installing later is safe whether or not
you drop the tables now. For a clean wipe:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "
DROP TABLE IF EXISTS webchat_approvals_index;
DROP TABLE IF EXISTS webchat_agent_models;
DROP TABLE IF EXISTS webchat_models;
DROP TABLE IF EXISTS webchat_room_primes;
DROP TABLE IF EXISTS webchat_room_settings;
DROP TABLE IF EXISTS webchat_messages;
DROP TABLE IF EXISTS webchat_push_subscriptions;
DROP TABLE IF EXISTS webchat_user_room_archives;
DELETE FROM schema_version WHERE name IN (
  'webchat-initial','webchat-drop-rooms','webchat-room-primes','webchat-models',
  'webchat-room-settings','webchat-approvals-index','webchat-user-archives'
);"
```

(`webchat_rooms` is intentionally absent — the `webchat-drop-rooms` migration
removed it, leaving the data on `messaging_groups`.)

### Webchat owners + uploads

```bash
pnpm exec tsx scripts/q.ts data/v2.db "DELETE FROM user_roles WHERE user_id LIKE 'webchat:%'; DELETE FROM users WHERE id LIKE 'webchat:%';"
rm -rf data/webchat/
```

---

## Manual fallback

If you can't run the script (e.g. the branch isn't reachable), reverse the
install by hand: restore the seven hooked core files from your trunk
(`git checkout <upstream>/main -- <file>` for each), `rm -rf` the webchat-owned
files listed above, delete the barrel import line, remove the migration import
block + symbols, `pnpm remove ws busboy web-push undici @types/ws @types/busboy
@types/web-push`, then `pnpm run build` and `./container/build.sh`.
