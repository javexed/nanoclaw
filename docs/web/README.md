# Web UI

NanoClaw's built-in browser interface: a single-user chat PWA served by the
host. It is a channel like any other — rooms are `messaging_groups`, messages
route through the per-session mailboxes — but it needs no phone app, no
platform account and no adapter install. It is in-tree, so there is nothing to
fetch: `WEB_ENABLED=true` in `.env` turns it on.

**Using it?** See the [user guide](USAGE.md). This page is the operator and
architecture reference: enable, auth, env, deploy, internals.

The interactive setup (`nanoclaw.sh`) offers it as a yes/no step — "Enable the
built-in web UI?" — ahead of the phone-channel question. Choosing yes writes
`WEB_ENABLED=true` and `WEB_HOST=127.0.0.1` (localhost-only, no token);
opening the port and minting a token comes later, from the in-app wizard.
Headless installs (`deploy/web-deploy.sh`) write the env keys directly and
skip the prompt.

## What it is

- **Chat** — rooms (one agent each), paginated history, live WebSocket
  updates, markdown, file attachments both directions, a thinking bubble
  (tool activity, streaming reasoning, per-agent Stop), approvals as
  actionable in-chat cards, and the slash commands `/clear`, `/compact`,
  `/context`, `/cost`, `/files`.
- **Management drawer (⚙)** — two tabs. *Agents*: create (optionally drafted
  from a one-line idea), set a per-agent model, edit standing instructions,
  delete. *Models*: the roster, a local Ollama console, and a probe for
  registering any Ollama or OpenAI-compatible endpoint.
- **First-run wizard** — model → access → first agent, auto-opening on a
  fresh install and re-runnable from the drawer.

Everything else — wirings, roles, scheduled tasks, cross-agent messaging — is
`ncl`. The drawer is deliberately not a second control plane.

## Auth

A bearer token (`WEB_TOKEN`, ≥24 chars), or localhost auto-pass — loopback is
trusted **only** when no explicit method is configured. The first identity to
authenticate is granted the owner role, which is also where approvals are
routed. Tailscale provides network reach and HTTPS (`tailscale serve`); it is
not an identity source.

## Env

| Var | Default | |
|---|---|---|
| `WEB_ENABLED` | `false` | master switch |
| `WEB_HOST` / `WEB_PORT` | `127.0.0.1` / `3100` | a non-loopback bind requires a token |
| `WEB_TOKEN` | — | bearer token; empty = localhost-only auto-auth |
| `WEB_PUBLIC_DIR` | `public/web` | static root |
| `WEB_TAILSCALE` | `true` | allow `tailscale serve` for HTTPS access |
| `WEB_TLS_CERT` / `WEB_TLS_KEY` | — | optional in-process HTTPS |
| `WEB_DRAFTER_MODEL` | `claude-haiku-4-5` | model behind "draft from an idea" |
| `WEB_BLOCK_PRIVATE_IPS` | `false` | refuse model endpoints on private ranges |

The channel also reads `OLLAMA_HOST` (default local Ollama endpoint) and
`AGENT_DISPLAY_NAME`.

## Deploy

One command on a prepared host (Node 22, pnpm, Docker):

```bash
bash deploy/web-deploy.sh --localhost                      # loopback, no token
sudo bash deploy/web-deploy.sh --install-deps --port 3100  # networked (Linux)
```

The networked path writes a token into `.env`, installs a service, and prints
the URL and token.

- **Linux** — systemd: a `--user` unit for `--localhost`, a system unit for
  networked deploys. `--install-deps` (Debian/Ubuntu) can bootstrap
  Node/pnpm/Docker first. Both units run `wait-for-onecli.sh` so the gateway
  is up before the host probes it.
- **macOS** — a per-user launchd agent (`com.nanoclaw-v2-<slug>`), the same
  shape the interactive setup installs. Prerequisites must already be present;
  there is no `--install-deps`.
- **Windows** — via WSL2 only: Docker Desktop with WSL integration, then the
  Linux path inside the distro. The `--user` unit needs systemd enabled in
  `/etc/wsl.conf`; otherwise use `--no-service` and start it yourself.

Service names are scoped by a hash of the checkout path, so several installs
on one machine never collide.

## Client build

The UI is vanilla TypeScript. `tsc` emits ES modules straight to
`public/web/js/` — no bundler, no framework. `pnpm run build` covers the host
and the client; `pnpm run build:ui` just the client. The emitted `js/` is
committed. The service worker's cache name is stamped per request from a
content hash of the public dir, so a deploy busts caches on its own.

## Architecture notes

- Rooms are `messaging_groups(channel_type='web')`. `web_messages` mirrors the
  conversation for the UI's history view, while routing and delivery flow
  through the per-session mailboxes like every other channel.
- Timestamps in `web_*` tables are INTEGER ms epochs, because the UI sorts and
  pages on them. This differs from the ISO-string convention of the core
  tables on purpose and is contained to these tables.
- The thinking bubble: the agent-runner writes `status_events` into the
  session's `outbound.db` (`container/agent-runner/src/status-feed.ts`); the
  host's `src/modules/agent-status` tails it on the delivery polls and
  forwards through the adapter's `sendStatus`.
- Attachments up to 25MB inline as base64 in the inbound message. Larger files
  ride a `hostPath` attachment that session-manager stages with
  `COPYFILE_EXCL`, after resolving symlinks and checking the result is inside
  the staging root.

### Local models

A registered model is wired to an agent by writing `ANTHROPIC_*` into the
agent's mounted `settings.json` (`envForModel` in
`src/channels/web/models.ts`):

- **Anthropic** models set `ANTHROPIC_MODEL`.
- **Ollama** models set `ANTHROPIC_BASE_URL` to the bare endpoint root,
  because Ollama serves the Anthropic API at `/v1/messages` — so a local model
  runs on the default Claude provider with no extra harness. `localhost` is
  rewritten to the Docker host-gateway so the container can reach the host,
  and that host is added to `NO_PROXY` so the call bypasses the OneCLI
  credential proxy, which fronts only known providers.
- **OpenAI-compatible** endpoints (LiteLLM, vLLM) are consumed the same way,
  through their Anthropic-spec surface.

This is the whole local-model path in this build, and it needs nothing
installed beyond Ollama itself.

If a local harness provider is installed, an Ollama assignment switches the
agent to it and writes `.claude-shared/local-model.json` instead. With none
installed, `providerForModelKind` returns null, the agent stays on the default
provider, and a stale uninstalled choice is un-wedged back to it so the group
can still spawn (`syncAgentProviderForAssignedModel`).
