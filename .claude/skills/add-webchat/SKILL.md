---
name: add-webchat
description: Enable the built-in web chat UI (a browser PWA on this machine).
---

# Add the web chat UI

Turns on NanoClaw's built-in web chat — a single-user browser PWA served by the
host process. Unlike the messaging channels (Slack, Telegram, …), webchat is
**in-tree**: its adapter already ships in trunk and its barrel import is already
present, so there is nothing to fetch from the `channels` branch, no dependency
to install, and no import to wire. Enabling it is a single env flag plus a
restart. The **Apply** steps carry `nc:` directive fences (an agent applies the
prose, a parser the directives); all idempotent.

Webchat is enabled **localhost-only** here — it binds `127.0.0.1` with no bearer
token, and the loopback auto-owner signs you in. Opening the port to your
network, minting a bearer token, and Tailscale HTTPS are all offered later from
the in-app first-run wizard (which also walks you through picking a model and
creating your first agent). See [docs/webchat/README.md](../../../docs/webchat/README.md).

If you ran the interactive `nanoclaw.sh` setup, it already asked whether to
enable webchat — this skill is the same action for an existing install, or for
the Claude Code `/add-webchat` surface.

## Apply

### 1. Enable webchat (localhost)

Set `WEBCHAT_ENABLED=true` + `WEBCHAT_HOST=127.0.0.1` in `.env`. This is a
force-upsert, not `nc:env-set`: webchat ships as `WEBCHAT_ENABLED=false`, and a
set-if-absent directive would leave that `false` untouched. The helper also
resets `WEBCHAT_HOST` to loopback so a lingering `0.0.0.0` from a prior
networked run can't silently keep the port open.

```nc:run effect:step
pnpm exec tsx scripts/enable-webchat.ts
```

### 2. Restart

Restart the host so it starts the webchat adapter and its HTTP + WebSocket
server:

```nc:run effect:restart
bash setup/lib/restart.sh
```

## Open it

Once the host is back up, open **http://127.0.0.1:3100/** in a browser (or your
configured `WEBCHAT_PORT`). The first visit runs a short wizard: pick an engine
(Claude sign-in, or a local Ollama model), then create your first agent. Rooms,
model management, and access controls all live in that UI.

To reach it from your phone or another device, open the ⚙ manage drawer →
**Run setup wizard…** → the access step, which generates a bearer token and can
enable Tailscale HTTPS. That path deliberately lives in the app, not here.

## Troubleshooting

**The page doesn't load / connection refused.** The host may not have picked up
the flag yet — confirm `WEBCHAT_ENABLED=true` is in `.env`, then restart again
(`bash setup/lib/restart.sh`). Check `logs/nanoclaw.error.log` for a bind error
(another process on the port → set a different `WEBCHAT_PORT` and restart).

**It asks for a token I never set.** A `WEBCHAT_TOKEN` is present in `.env` (from
a prior networked run or the in-app access step). Either log in with that token,
or remove the `WEBCHAT_TOKEN` line, set `WEBCHAT_HOST=127.0.0.1`, and restart to
return to loopback auto-login.

**It's reachable from the network and you didn't intend that.** `WEBCHAT_HOST`
is `0.0.0.0`. Re-run `pnpm exec tsx scripts/enable-webchat.ts` (it resets the
bind to `127.0.0.1`) and restart.

**Disable it.** `pnpm exec tsx scripts/enable-webchat.ts --disable`, then
restart. See [REMOVE.md](REMOVE.md).
