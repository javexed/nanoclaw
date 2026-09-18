# Remove the web UI

The web UI is in-tree, so there are no files to delete and no package to uninstall
— removal is just disabling the flag and restarting. Every step is idempotent.

## 1. Disable the flag

Sets `WEB_ENABLED=false` in `.env`:

```bash
pnpm exec tsx scripts/enable-web.ts --disable
```

## 2. Remove any access config (optional)

If the in-app access step was used, `.env` may carry `WEB_TOKEN`,
`WEB_HOST=0.0.0.0`, and/or `WEB_PORT`. Remove those lines to drop the
network exposure and bearer login; leaving them is harmless once
`WEB_ENABLED=false`, since the adapter factory returns null when disabled.

## 3. Restart

```bash
bash setup/lib/restart.sh
```

The host comes back without the web adapter or its HTTP server. Existing
`messaging_groups(channel_type='web')` rooms and their wirings stay in the
database (inert while disabled) and reactivate if you re-enable web later; to
remove them, delete the rooms from the UI before disabling, or with `ncl`.
