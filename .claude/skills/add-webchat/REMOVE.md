# Remove Webchat

Reverses the `add-webchat` install. Each step is idempotent.

## 1. Stop the host

```bash
# macOS
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist

# Linux
systemctl --user stop nanoclaw
```

## 2. Disable the channel

In `.env`, set:

```bash
WEBCHAT_ENABLED=false
```

This alone is enough to quietly disable the channel without removing files. The remaining steps fully uninstall.

## 3. Remove the channel registration

In `src/channels/index.ts`, **delete** the line (don't comment — the install step's grep guard would treat a commented line as "already installed" and skip re-adding on a future re-install):

```typescript
import './webchat/index.js';
```

## 4. Remove the migration registration

Edit `src/db/migrations/index.ts` and remove **all** of the following in the same edit (TypeScript will fail to compile in the in-between state — symbols are dangling or unused):

1. The import line — remove the entire import block:

   ```typescript
   import {
     moduleWebchat,
     moduleWebchatDropRooms,
     moduleWebchatRoomPrimes,
     moduleWebchatModels,
     moduleWebchatApprovalsIndex,
   } from '../../channels/webchat/migration.js';
   ```

2. All five entries inside the `migrations` array:

   ```typescript
   moduleWebchat,
   moduleWebchatDropRooms,
   moduleWebchatRoomPrimes,
   moduleWebchatModels,
   moduleWebchatApprovalsIndex,
   ```

Do not run `pnpm run build` until both edits are done.

The `webchat_*` tables remain in the central DB. SQLite has no auto-rollback for migrations; each migration's `up()` is idempotent (`CREATE TABLE IF NOT EXISTS`), so re-installing later is safe whether or not you drop the tables now. If you want a clean wipe:

```bash
sqlite3 data/v2.db <<'EOF'
-- Tables (6 total — all five migrations' targets)
DROP TABLE IF EXISTS webchat_approvals_index;
DROP TABLE IF EXISTS webchat_agent_models;
DROP TABLE IF EXISTS webchat_models;
DROP TABLE IF EXISTS webchat_room_primes;
DROP TABLE IF EXISTS webchat_messages;
DROP TABLE IF EXISTS webchat_push_subscriptions;
-- Note: webchat_rooms is intentionally absent — it was dropped by the
-- webchat-drop-rooms migration itself, leaving the data on messaging_groups.
-- Schema-version rows (5 total)
DELETE FROM schema_version WHERE name IN (
  'webchat-initial',
  'webchat-drop-rooms',
  'webchat-room-primes',
  'webchat-models',
  'webchat-approvals-index'
);
EOF
```

## 5. Remove source files

```bash
rm -rf src/channels/webchat
rm -rf public/webchat
rm -f src/modules/agent-to-agent/create-agent.test.ts
```

`create-agent.test.ts` was added by step 1 of install. Don't `rm -rf
src/modules/agent-to-agent` — that directory belongs to trunk and other
files in it are pre-existing.

## 6. Uninstall packages

```bash
pnpm remove ws busboy web-push undici
pnpm remove -D @types/ws @types/busboy @types/web-push
```

## 7. Drop env entries

In `.env`, remove (or comment out):

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

## 8. Optional: drop user_roles webchat owners

If you removed the permissions module entirely, the `user_roles` rows webchat created (`webchat:owner`, `webchat:local-owner`, etc.) become orphaned. You can leave them — they're harmless without the channel — or clean them up:

```bash
sqlite3 data/v2.db "DELETE FROM user_roles WHERE user_id LIKE 'webchat:%';"
sqlite3 data/v2.db "DELETE FROM users WHERE id LIKE 'webchat:%';"
```

## 9. Optional: drop uploaded files

```bash
rm -rf data/webchat/
```

## 10. Reverse the a2a `create_agent` auth-gate patch

Strips the auth gate that SKILL.md step 6 added. Idempotent — no-op if
not patched. After running, `src/modules/agent-to-agent/create-agent.ts`
is byte-identical to the upstream version.

```bash
node .claude/skills/add-webchat/install/unpatch-create-agent.mjs
```

## 11. Reverse the agent-runner send_file patch

Strips the `send_file` prompt hint that SKILL.md step 7 added.
Idempotent — no-op if not patched.

```bash
node .claude/skills/add-webchat/install/unpatch-destinations.mjs
```

## 12. Rebuild the agent container image

Required for the unpatched `destinations.ts` to take effect on running
agents:

```bash
./container/build.sh
```

## 13. Rebuild host & restart

```bash
pnpm run build
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist   # macOS
systemctl --user start nanoclaw                            # Linux
```
