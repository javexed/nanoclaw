# Webchat

A single-user chat PWA built into this NanoClaw fork. In-tree — no overlay
repo, no install skill; `WEBCHAT_ENABLED=true` in `.env` turns it on.

The interactive setup (`nanoclaw.sh`) offers this as a yes/no step —
"Enable the built-in web chat UI?" — ahead of the phone-channel question.
Choosing yes writes `WEBCHAT_ENABLED=true` + `WEBCHAT_HOST=127.0.0.1`
(localhost-only, no token); opening the port and minting a bearer token is
offered later from the in-app first-run wizard. Headless installs
(`deploy/webchat-deploy.sh`) set these env keys directly and skip the prompt.

## What it is

- **Chat**: rooms (one agent per room), paginated history, live WebSocket
  updates, markdown, file attachments both directions, a live thinking bubble
  (tool activity + streaming reasoning + per-agent Stop), approval requests as
  actionable in-chat cards, slash commands (`/clear /compact /context /cost
  /files`).
- **Management drawer** (⚙): agents (create with the LLM drafter, per-agent
  model, delete), model roster (anthropic / ollama / openai-compatible, with
  discovery + endpoint probe + container-vantage reachability), and an Ollama
  console (pull with progress, delete, hardware recommendation, one-click
  local install). Everything else is `ncl`.
- **First-run wizard**: engine (Claude via the OneCLI vault, or a local
  Ollama model) → model pull → access (Tailscale HTTPS / bearer token) →
  first agent. Auto-opens on a fresh install.

## Auth

Bearer token (`WEBCHAT_TOKEN`, ≥24 chars) or localhost auto-pass — loopback
is trusted **only** when no explicit method is configured. The first identity
to authenticate is granted the owner role (which routes approvals to its
inbox). Tailscale is network access + HTTPS (`tailscale serve`), not
identity.

## Env

| Var | Default | |
|---|---|---|
| `WEBCHAT_ENABLED` | `false` | master switch |
| `WEBCHAT_HOST` / `WEBCHAT_PORT` | `127.0.0.1` / `3100` | non-loopback bind requires a token |
| `WEBCHAT_TOKEN` | — | bearer token; empty = localhost-only auto-auth |
| `WEBCHAT_PUBLIC_DIR` | `public/webchat` | static root |
| `WEBCHAT_TLS_CERT/KEY` | — | optional in-process HTTPS |

## Deploy

One command on a prepared host (Node 22, pnpm, Docker):

```bash
bash deploy/webchat-deploy.sh --localhost   # loopback, no token, per-user service
sudo bash deploy/webchat-deploy.sh --install-deps --port 3100   # networked (Linux)
```

The networked path writes a bearer token into `.env`, installs a service, and
prints the URL + token. Per platform:

- **Linux** — systemd: a `--user` unit for `--localhost`, a system unit (root)
  for networked deploys. `--install-deps` (Debian/Ubuntu, apt) can bootstrap
  Node/pnpm/Docker first. Both units run `wait-for-onecli.sh` so the OneCLI
  gateway is up before the host probes it.
- **macOS** — a per-user launchd LaunchAgent (`com.nanoclaw-v2-<slug>`), same
  shape as the interactive setup's; the OneCLI wait runs inside the launch
  command. Prereqs (Node 22, pnpm, Docker Desktop) must already be installed —
  there is no `--install-deps` on macOS.
- **Windows** — via WSL2 only: Docker Desktop with WSL integration, then the
  Linux path inside the distro (the `--user` unit needs systemd enabled in
  `/etc/wsl.conf`; otherwise `--no-service` and start manually).

Service names are slug-scoped (sha1 of the checkout path), so multiple
installs on one machine never clobber each other.

## Client build

The UI is vanilla TypeScript — `tsc` emits ES modules straight to
`public/webchat/js/` (no bundler, no framework). `pnpm run build` covers both
trees; `pnpm run build:ui` just the client. The emitted `js/` is committed;
the service worker's cache name is stamped per request from a content hash of
the public dir, so deploys bust caches automatically.

## Architecture notes

- Rooms are `messaging_groups(channel_type='webchat')`; `webchat_messages`
  mirrors the conversation for the UI, while routing/delivery flow through
  the per-session mailboxes like every other channel.
- The thinking bubble: the agent-runner writes `status_events` into the
  session's outbound.db (`container/agent-runner/src/status-feed.ts`); the
  host's `src/modules/agent-status` tails it on the delivery polls and
  forwards via the adapter's `sendStatus`.
- Attachments ≤25MB inline as base64 into the inbound message; larger files
  ride a `hostPath` attachment that session-manager stages with
  `COPYFILE_EXCL` after a DATA_DIR containment check.
- Assigning an ollama-kind model to an agent auto-switches its harness to the
  in-tree OpenCode provider and materializes
  `.claude-shared/local-model.json`; Claude-family assignments write the
  `ANTHROPIC_*` env into the mounted `settings.json`.
