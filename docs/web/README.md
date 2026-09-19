# Web UI

NanoClaw's built-in browser interface: a single-user chat PWA served by the
host. It is a channel like any other — rooms are `messaging_groups`, messages
route through the per-session mailboxes — but it needs no phone app, no
platform account and no adapter install. It is in-tree, so there is nothing to
fetch: `WEB_ENABLED=true` in `.env` turns it on.

**Using it?** See the [user guide](USAGE.md). This page is the operator and
architecture reference: enable, auth, env, deploy, internals.

The interactive setup (`nanoclaw.sh`) asks "Enable the web UI?" up
front, before the image build. Yes writes `WEB_ENABLED=true` and
`WEB_HOST=127.0.0.1` (localhost-only, no token), and changes what the rest of
the run does: the terminal handles only what a browser can't — the image, the
gateway, the service — then waits for the web UI to come up and offers to
open it. The in-app wizard takes it from there (model → access → first agent),
so the phone-channel, first-agent and first-chat steps are skipped. No keeps
the phone-channel flow. Headless installs (`deploy/web-deploy.sh`) write the
env keys directly and never see the prompt.

## Install

The web UI lives on the `nanoclaw-web` branch — upstream `main` does not
carry it — so clone the branch, not the default:

```bash
git clone -b nanoclaw-web https://github.com/javexed/nanoclaw.git nanoclaw-v2
cd nanoclaw-v2
```

Then one of three paths.

**Interactive, from a fresh machine.** `bash nanoclaw.sh` installs Node, pnpm
and Docker if they are missing. Answer yes to "Enable the web UI?"
— it's the first real question — then let it build. When the service is up it
offers to open the web UI: press Enter, or open **http://127.0.0.1:3100/**
yourself. The rest of setup happens there (model → access → first agent).

**An install you already have.** In Claude Code, run `/add-web`; or by hand:

```bash
pnpm exec tsx scripts/enable-web.ts   # WEB_ENABLED=true, WEB_HOST=127.0.0.1
bash setup/lib/restart.sh
```

**Headless, on a server.** See [Deploy](#deploy) — one command writes the
env, mints a token and installs a service.

All three leave it localhost-only with no token. Reaching it from another
device is offered from inside the app (⚙ → Run setup wizard… → access).

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

## Learning

An agent can distill a reusable lesson from its own session into a
`SKILL.md`; a person keeps or discards it from the room; a kept skill lands
on **that agent only**. Nothing the loop produces ever runs without someone
keeping it first.

```
/learn  ·  busy turn (auto)      Keep / Discard card        kept
        │                              │                       │
        ▼                              ▼                       ▼
 isolated review pass ──► staged draft (never live) ──► agent's scoped skills
 (draft_skill is its only tool)                        → agent restarts
```

**Two triggers, one code path.** `/learn` in the composer runs a review now
(trailing text steers it: `/learn keep the rsync part even though it's
well-known`). **Auto-learn** — per agent, default on, ⚙ → Agents — runs the
same review by itself after a busy turn (≥ 5 tool calls), at most once per
30 minutes per container. Auto reviews are silent unless they find something;
the card is the announcement.

**The review can't act.** It is a second query with the toolset dropped to
`draft_skill` alone — no shell, no files, no destinations. It runs over a
bounded digest of the session's recent exchanges (last 12, ≤ 24k chars) as a
fresh query, so it costs a few thousand tokens and leaves the main
conversation untouched; on a container that has recorded no exchange yet, it
forks the live session instead and discards the fork. For `/learn` the
one-line outcome — "drafted X" or "nothing worth keeping" — lands in the
room; a failed review says so too. The authoring prompt carries a denylist (environment-specific
breakage, transient errors, one-off narratives) and the rule that an empty
answer is a good answer. It is shown the skills the agent already has and
must **patch** one rather than create a near-duplicate; a colliding create is
coerced into a patch, a patch of a nonexistent skill is rejected.

**Keep runs an overlap check.** Token similarity against the agent's scoped
skills, its other pending drafts and the shared pool — always; plus a local
model's judgment when `NANOCLAW_OVERLAP_MODEL` is set. A hit asks "keep
anyway?". Keep then writes the skill under the agent's scoped dir, stamps
`.origin.json` with `learned`, and restarts the agent's containers. A new
skill may not shadow a pooled one; patching a pooled skill forks it into the
agent's own copy and leaves the pool alone.

| Env var | Default | |
|---|---|---|
| `NANOCLAW_LEARNING_MODEL` | (turn model) | model for the review pass |
| `NANOCLAW_OVERLAP_MODEL` | — | local model for the Keep overlap judge; unset = heuristic only |
| `NANOCLAW_OVERLAP_URL` | `http://127.0.0.1:11434` | Anthropic-format `/v1/messages` endpoint for it (Ollama serves one) |

Where things live: drafts in `skill_drafts` (body at
`data/skill-drafts/<id>/SKILL.md`; deleting an agent discards its pending
drafts); the switch in `learning_agent_settings`, materialized into the
agent's `container.json` as `learning`; kept skills in
`data/v2-sessions/<agent>/.claude-shared/skills/<name>/`. Host side is
`src/modules/learning/`, container side `container/agent-runner/src/learning-loop.ts`
and `mcp-tools/draft-skill.ts`; the web channel only draws the card.

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

Anything in the roster that is not an Anthropic model — Ollama, LM Studio,
vLLM, a LiteLLM router — is a local OpenAI-compatible backend, and local
backends run on **OpenCode**, upstream's install-on-demand harness
(`/add-opencode`). They never run on the Claude provider. Until OpenCode is
installed there is no harness for them: assigning one leaves the agent on the
default provider.

This is upstream's own contract, followed exactly
(`syncAgentProviderForAssignedModel`, `syncOpenCodeBackendEnv` in
`src/channels/web/models.ts`):

| what | where upstream reads it |
|---|---|
| which harness an agent uses | `container_configs.provider = 'opencode'` |
| which model | `container_configs.model = 'openai/<id>'` — per agent; the runner strips the prefix |
| which backend | install-wide `.env`: `OPENCODE_PROVIDER=openai`, `OPENCODE_BASE_URL=<endpoint>/v1`, `OPENCODE_MODEL`, `OPENCODE_MODEL_CONTEXT_LIMIT` + `OPENCODE_MODEL_OUTPUT_LIMIT` |
| reaching a backend on the host | `NO_PROXY` carries the docker host alias, so the call bypasses the credential proxy |

Assigning a local model to an agent writes all of that: the backend keys into
`.env` (the two limits only if absent, so an operator's values stick — both are
required, or OpenCode's session creation fails), the provider and model onto the
agent's container config, and `NO_PROXY` into both `.env` and the host
process's environment. The last is deliberate: upstream's host provider reads
`NO_PROXY` from the process environment and does not yet fall back to `.env`,
so the process copy is what reaches the container today.

**One backend per install** is the shape upstream offers. The roster can hold
several endpoints, but the one most recently assigned is the install's OpenCode
backend; the model stays per agent. Anthropic models are unaffected — they set
`ANTHROPIC_MODEL` in the agent's mounted `settings.json` as before.
