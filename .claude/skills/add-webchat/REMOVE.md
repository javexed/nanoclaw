# Remove the web chat UI

Webchat is in-tree, so there are no files to delete and no package to uninstall
— removal is just disabling the flag and restarting. Every step is idempotent.

## 1. Disable the flag

Sets `WEBCHAT_ENABLED=false` in `.env`:

```bash
pnpm exec tsx scripts/enable-webchat.ts --disable
```

## 2. Remove any access config (optional)

If the in-app access step was used, `.env` may carry `WEBCHAT_TOKEN`,
`WEBCHAT_HOST=0.0.0.0`, and/or `WEBCHAT_PORT`. Remove those lines to drop the
network exposure and bearer login; leaving them is harmless once
`WEBCHAT_ENABLED=false`, since the adapter factory returns null when disabled.

## 3. Restart

```bash
bash setup/lib/restart.sh
```

The host comes back without the webchat adapter or its HTTP server. Existing
`messaging_groups(channel_type='webchat')` rooms and their wirings stay in the
database (inert while disabled) and reactivate if you re-enable webchat later; to
remove them, delete the rooms from the UI before disabling, or with `ncl`.
