---
name: add-webchat
description: Add an embedded HTTP + WebSocket chat server with PWA frontend. Provides a web chat interface for talking to NanoClaw agents from the browser, with bearer / tailscale / proxy-header auth and Web Push.
---

# Add Webchat

Adds an in-process chat server + PWA. Runs on its own port (default 3100); doesn't share with `webhook-server`. The PWA talks to v2's agent groups via webchat-owned room metadata, and pipes inbound chat through the standard channel-adapter path so the existing router / sessions / outbound delivery flow handles it like any other channel.

> **Maintainers:** publishing a change to webchat (review remote → public mirror)? Follow [PUBLISHING.md](PUBLISHING.md) — step 2 is the `verify-webchat-publish.sh` gate.

## Prerequisites

Webchat layers on top of a working v2 install — it does not replicate `/setup`. Before installing, make sure these are in place. (`/setup` handles all of them; if you ran `/setup` end-to-end, skip this section.)

1. **Per-checkout container image is built.** v2 names the agent image `nanoclaw-agent-v2-<sha1(projectRoot)[:8]>:latest` so multiple installs can share a docker daemon. Without it, every session wake fails with `pull access denied for nanoclaw-agent-v2-...` (exit 125) and the agent never replies.

   ```bash
   ./container/build.sh
   docker images | grep nanoclaw-agent-v2-   # confirm the image exists
   ```

2. **A credential path for the agent container.** Either OneCLI or the native credential proxy must be configured so containers can authenticate to the LLM provider. Webchat will boot and accept messages without it, but every spawn will land in `outbound.db` empty (the agent-runner exits with no credentials).

   - **OneCLI** — set `ONECLI_URL` in `.env` to your local gateway (typically `http://172.17.0.1:10254`). If `ONECLI_URL` is unset, the SDK defaults to `https://app.onecli.sh` (the cloud) and 401s. Verify with `curl ${ONECLI_URL}/api/agents`.
   - **Native credential proxy** — install via `/use-native-credential-proxy` and set `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) in `.env`.

3. **`pnpm run dev` doesn't auto-load `.env`** in v2 trunk. If you're running the host in dev mode, export the env first: `set -a; source .env; set +a; pnpm run dev`. `launchctl` / `systemd` aren't affected (they pass env directly).

## Install

Webchat's source-of-truth lives on the long-lived `channels-webchat` branch — same pattern the `channels` branch uses for Discord/Slack/etc. The install is wrapped in two scripts that ship on the branch: a deterministic `install-webchat.sh` and an interactive `configure-webchat.sh`. The SKILL.md just bootstraps them.

### Pre-flight

`/add-webchat` is safe to run repeatedly — both scripts are idempotent.

You need a `pnpm` in PATH (the project pins `pnpm@10.33.0`). If you usually run NanoClaw, you have one. If not, install via npm or mise — see `CLAUDE.md`'s "Development" section.

### 1. Detect remote + fetch the channel branch

`channels-webchat` lives on the same remote that hosts the `skill/webchat` branch you just merged. Auto-detect:

```bash
WEBCHAT_REMOTE=$(git branch -r | grep -E '/skill/webchat$' | awk -F'/' '{print $1}' | sort -u | head -1 | xargs)
if [ -z "$WEBCHAT_REMOTE" ]; then
  echo "ERROR: no remote carries 'skill/webchat' — fetch the remote that hosts this skill first." >&2
  exit 1
fi
git fetch "$WEBCHAT_REMOTE" channels-webchat
```

If multiple remotes carry `skill/webchat`, the script picks the alphabetically-first; override with `WEBCHAT_REMOTE=<name>` in the environment.

### 2. Check out and run the install script

```bash
git checkout "$WEBCHAT_REMOTE/channels-webchat" -- install-webchat.sh configure-webchat.sh
WEBCHAT_REMOTE="$WEBCHAT_REMOTE" ./install-webchat.sh
```

This single script does the deterministic work:

- **Copies webchat-owned new files** (the `src/channels/webchat/` module, `public/webchat/` UI, and the new test files) from the branch — these don't exist upstream, so nothing is overwritten. Left unstaged so you review a plain `git diff`.
- **Applies the core-file hooks** to the handful of trunk files webchat extends (`index.ts`, `router.ts`, `delivery.ts`, `channels/adapter.ts`, `agent-to-agent/create-agent.ts`, `cli/resources/destinations.ts`, `agent-runner/destinations.ts`). Rather than overwriting your copy, it applies the webchat delta as a **guarded 3-way patch**: it skips files already hooked (idempotent re-runs), tolerates upstream drift via 3-way merge, and on a genuine conflict it reverts the file and reports it loudly instead of leaving broken markers. Fully reversible — see "Removing webchat" below.
- Appends the channels-barrel import and idempotently registers the webchat migrations in `src/db/migrations/index.ts` (upgrade-safe — adds only missing entries, so installing a newer webchat version just adds the new symbols).
- Runs `pnpm add` for the pinned deps + their `@types`, `pnpm run build`, and rebuilds the agent container image.

Skip the container image step (e.g., in CI) with `SKIP_CONTAINER_BUILD=1`.

If it fails partway through, the script exits non-zero with a clear message; the changes already applied stay in place (idempotent re-run is safe). Common failures:

- **`pnpm: command not found`** — install pnpm first (see Pre-flight).
- **`fatal: ambiguous argument 'channels-webchat'`** — the fetch in step 1 didn't actually pull the branch. Confirm `WEBCHAT_REMOTE` is correct and that the remote URL is reachable.
- **TypeScript build errors** — most likely an upstream drift in `src/modules/agent-to-agent/create-agent.ts` or `container/agent-runner/src/destinations.ts`. Report; the fix lives on `channels-webchat` (merge `main` in, resolve, push).

### 3. Run the interactive configure script

```bash
./configure-webchat.sh
```

Asks (with safe defaults if non-TTY):

- Network access mode (localhost / network)
- Auth method for network mode (bearer / tailscale / proxy-header)
- VAPID subject email (for Web Push)

Writes idempotent additions to `.env`, generates a VAPID keypair if absent (never rotates an existing one), and syncs to `data/env/env`.

For exotic configs not covered (TLS, multiple auth methods, custom `WEBCHAT_PORT`/`WEBCHAT_HOST`, opt-out of push), edit `.env` by hand after — see the **Configure** section below for the full menu.

## Configure

> **Re-running this section is safe** if every variable you add follows the idempotent pattern shown below. Running install twice will otherwise duplicate lines in `.env` (most env loaders take the last write, so this is benign — but ugly). When following the snippets below, prefer the `grep -q ... || echo ... >> .env` form over copy-paste.

The server is disabled by default. Enable it now:

```bash
grep -q '^WEBCHAT_ENABLED=' .env || echo 'WEBCHAT_ENABLED=true' >> .env
```

### Network access & authentication

**STOP — you must ask this before proceeding.** Use `AskUserQuestion`:

**"Should the chat server be accessible from other devices on your network, or only from this machine?"**

Options:

1. **Localhost only** (recommended, most secure)
2. **Network accessible** (LAN, Tailscale, or behind a reverse proxy)

Do NOT skip this question or assume localhost.

#### Option 1: Localhost only

No further configuration needed.

```bash
WEBCHAT_ENABLED=true
# WEBCHAT_PORT=3100        # default
# WEBCHAT_HOST=127.0.0.1   # default
```

> ⚠️ **Reverse-proxy gotcha.** Localhost-only does **not** protect against fronting reverse proxies that forward to `127.0.0.1` — Tailscale Serve, nginx, Caddy, oauth2-proxy, Cloudflare Tunnel. If you have one of those exposing this host, every request lands at webchat as if it came from loopback. Two safe options: (a) tear down the forward (e.g. `tailscale serve --https=443 off`), or (b) configure `WEBCHAT_TOKEN` / `WEBCHAT_TAILSCALE` / `WEBCHAT_TRUSTED_PROXY_IPS` — once any explicit auth method is set, the loopback auto-pass is disabled and the proxy must surface the upstream identity. Quick check: `tailscale serve status` and `ss -tlnp | grep -v 127.0.0.1` from this host.

#### Option 2: Network accessible

The server **refuses to start** when bound to a non-loopback host without at least one explicit auth method. Pick one or more:

**Bearer token** (works everywhere):

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(32))"   # generate a token
```

```bash
WEBCHAT_ENABLED=true
WEBCHAT_HOST=0.0.0.0
WEBCHAT_TOKEN=<generated-token>
```

Tell the user to save the token — they'll need it the first time they connect.

**Tailscale** (zero-config for tailnet users):

```bash
WEBCHAT_ENABLED=true
WEBCHAT_HOST=0.0.0.0
WEBCHAT_TAILSCALE=true
```

The server runs `tailscale whois` against the remote IP and uses the email as the user identity (`webchat:tailscale:<email>`).

> **Heads up — same-machine localhost won't work in this mode.** With `WEBCHAT_TAILSCALE=true` set, the loopback auto-pass is disabled (it has to be — see the reverse-proxy gotcha above), and `tailscale whois 127.0.0.1` returns no identity. So even from this host, the PWA must be opened by tailnet hostname or IP, not `127.0.0.1`. Bookmark `http://<your-tailnet-hostname>:3100/` (e.g. via MagicDNS) or `http://$(tailscale ip -4):3100/`. Curl from the local shell needs the same — `curl http://127.0.0.1:3100/...` returns 401.

**Reverse-proxy header** (for SSO via oauth2-proxy, Cloudflare Access, Azure EasyAuth, etc.):

```bash
WEBCHAT_ENABLED=true
WEBCHAT_HOST=0.0.0.0
WEBCHAT_TRUSTED_PROXY_IPS=10.0.0.5            # explicit IP/CIDR (recommended)
# WEBCHAT_TRUSTED_PROXY_IPS=auto               # auto-detect Azure / Cloudflare
# WEBCHAT_TRUSTED_PROXY_HEADER=x-forwarded-user  # default; override if needed
```

Identity comes from the asserted header (`webchat:<header-value>`). With `auto`, Azure EasyAuth (`x-ms-client-principal-name`) and Cloudflare Access (`cf-access-authenticated-user-email`) are detected first.

### Optional: TLS

Provide a cert + key to serve over HTTPS:

```bash
WEBCHAT_TLS_CERT=/path/to/fullchain.pem
WEBCHAT_TLS_KEY=/path/to/privkey.pem
```

### Web Push (VAPID)

Generate and persist a VAPID key pair now. Without this the PWA shows a `server missing VAPID key` warning the moment it tries to subscribe — every fresh install hits it, so do this by default rather than leaving it for later.

The block below is idempotent: it skips if `WEBCHAT_VAPID_PUBLIC_KEY` is already set, so re-running install won't rotate the keys (which would invalidate every existing browser subscription).

```bash
if ! grep -q '^WEBCHAT_VAPID_PUBLIC_KEY=' .env; then
  KEYS=$(pnpm exec web-push generate-vapid-keys --json)
  PUB=$(echo "$KEYS"  | python3 -c 'import json,sys; print(json.load(sys.stdin)["publicKey"])')
  PRIV=$(echo "$KEYS" | python3 -c 'import json,sys; print(json.load(sys.stdin)["privateKey"])')
  echo "WEBCHAT_VAPID_PUBLIC_KEY=$PUB"   >> .env
  echo "WEBCHAT_VAPID_PRIVATE_KEY=$PRIV" >> .env
fi
```

The subject is a `mailto:` URL the push service can use to contact you about deliverability problems. **Ask the user for an email** — `AskUserQuestion: "Email address for VAPID subject (where push services should reach you about deliverability)?"` — and write it in:

```bash
SUBJECT_EMAIL="<answer>"
grep -q '^WEBCHAT_VAPID_SUBJECT=' .env || echo "WEBCHAT_VAPID_SUBJECT=mailto:${SUBJECT_EMAIL}" >> .env
```

To opt out of push entirely, leave all three keys empty — the rest of the chat server works regardless, and the PWA's push button stays disabled cleanly.

### Sync env to container

```bash
mkdir -p data/env && cp .env data/env/env
```

## Identity & roles

The first authenticated user becomes the **owner** automatically (one-time grant, persisted in `user_roles`). Owner can:

- Create / delete agent groups via `POST /api/agents`
- Wire / unwire rooms
- Edit any agent's `CLAUDE.local.md`

Subsequent users have no role. The owner can grant `admin` (global or scoped to a specific agent group) to others — admins of agent group X manage X but not others. This works automatically because v2's `command-gate.ts` and the webchat admin endpoints both consult `user_roles` via `hasAdminPrivilege(userId, agentGroupId)`.

When the **permissions module is not installed**, the gate degrades to "single trusted operator" — anyone with bearer / tailscale / proxy access has full control. To get the full role model, install permissions before webchat.

## Restart

Restart the host so the new channel adapter loads:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

## Channel Info

- **type**: `webchat`
- **terminology**: a "room" is a webchat-owned chat space (it's a `messaging_groups` row with `channel_type='webchat'`; the room id is its `platform_id`).
- **provisioning**: two endpoints, both supported and not redundant —
  - `POST /api/agents` (agent-first): creates an agent + a 1:1 room with the agent's folder as the room id. Use when you're thinking "give me a chat-accessible agent."
  - `POST /api/rooms` (room-first): creates a room and wires 1+ agents to it (existing or inline-new). Use when you're thinking "set up a conversation space" or want multi-agent rooms.
- **supports-threads**: no — rooms ARE the conversation unit.
- **typical-use**: local web chat for talking to your own agents from any browser on your machine, LAN, or tailnet.
- **default-isolation**: typically per-room. The underlying entity model (`messaging_group_agents`) is many-to-many — the PWA exposes this via `+ Add agent` in room settings.
- **prime agent (per-room)**: a room can opt-in to "prime" routing by starring one wired agent in room settings. The prime answers every message that doesn't `@<folder>`-mention another wired agent. The mentioned agent answers those. Implemented entirely by rewriting `messaging_group_agents.engage_pattern` (negative-lookahead for the prime, positive `\B@<folder>\b` for others) — the existing v2 router does the actual gating via `engage_mode='pattern'`. No router-side change. Storage: `webchat_room_primes(room_id, agent_group_id)`. Endpoints: `PUT /api/rooms/:id/prime { agentId }`, `DELETE /api/rooms/:id/prime`. The `is_prime` flag is included in `GET /api/rooms/:id/agents`.
- **archive (per-user)**: a room can be hidden from the sidebar via the kebab menu on each room entry. Archive is per-user — different users can independently hide rooms from their own sidebar without affecting routing or other users' views. New messages still arrive in archived rooms (unread badges still fire); manual unarchive only (no auto-resurface on inbound). A "Show N archived" footer toggle reveals the hidden set inline (visually dimmed). Storage: `webchat_user_room_archives(user_id, room_id, archived_at)`. Endpoints: `POST /api/rooms/:id/archive`, `POST /api/rooms/:id/unarchive`. `GET /api/rooms` and the WS `rooms` broadcast include `archived: boolean` per room, per requesting user.
- **models (per-agent)**: a third sidebar tab "Models" lets the operator register LLM endpoints/configurations and assign them to agents. MVP supports two kinds: `anthropic` (pin to a custom Anthropic model_id, reuses the agent's existing OneCLI Anthropic credential) and `ollama` (route at a local Ollama endpoint; no auth needed, Ollama speaks the Anthropic API at `<endpoint>/v1/messages`). Health-checked on save (Ollama: `/api/tags` reachability + model-name verification). Auto-discovery available via `POST /api/models/discover`. Implementation is trunk-free — assignments are written into the per-agent `data/v2-sessions/<agent>/.claude-shared/settings.json` env block (`ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`); the SDK's user setting source applies them at startup. Effect timing: takes effect on the next container spawn for the agent. Storage: `webchat_models` + `webchat_agent_models` (1:1 PK on `agent_group_id`). Endpoints: `GET/POST /api/models`, `PUT/DELETE /api/models/:id` (DELETE returns 409 + impact list when assigned; re-POST with `?force=1` to cascade-unassign), `POST /api/models/discover`, `PUT /api/agents/:id/model { modelId | null }`. The `assigned_model_id` field is included in `GET /api/agents`. Future kinds (e.g. OpenAI-compatible) will use the `credential_ref` column to point at OneCLI secret names — out of MVP scope.
- **agent drafter (✨ Suggest from prompt)**: the three create-agent flows (Agents tab, room-create inline-new-agent, room-settings + Add agent New tab) include a freeform prompt + ✨ button. Click it and the host calls `POST /api/agents/draft { prompt }`, returning a suggested `{ name, instructions }` that populates the form for the operator to review. **Host-side LLM call** routed through the OneCLI gateway with a reserved `webchat-drafter` agent identifier (registered with OneCLI on first use, idempotent). The host never holds the raw API key — OneCLI's proxy injects auth on each call, same model containers use. Per the v2 CLAUDE.md OneCLI gotcha, the drafter identifier starts in `selective` secret mode and 401s on the first call; one-time fix: `onecli agents list` to find the internal id, then `onecli agents set-secret-mode --id <internal-id> --mode all`. Latency ~3-5s per request (network-bound, no container spawn). Owner-only.

## Known caveats (preview state)

This skill is upstream-PR scope; the following are known follow-ups:

- **Orphan-room reconciliation interaction**: the PWA's WS auth handshake calls `reconcileOrphanAgents`, which provisions a 1:1 room for any agent without one. If you delete a room but leave the agents, the next PWA connect will recreate per-agent 1:1 rooms for them. Delete the agents too if you want them gone, or accept the auto-room as the v2 default.
- **File mounts**: uploaded files land under `data/webchat/uploads/<roomId>/`. They are served via HTTP, not mounted into agent containers (v1 wrote files into the agent's group folder so the agent could `cat` them; that path doesn't generalise to v2's fan-out model). Agents that need file bytes can fetch the URL.
- **Agent creation via chat** (v1's `/api/bots/create-from-chat` "ask main to register") is dropped. Use `POST /api/agents` (agent-first) or `POST /api/rooms` (room-first) directly from the PWA.

## Create your first agent

A fresh webchat install has no agents yet, and `/init-first-agent` doesn't have a webchat code path. Use `POST /api/agents` with `withRoom: true` instead — that opt-in flag tells the handler to provision the agent group, initialize the on-disk filesystem (`groups/<folder>/CLAUDE.local.md`), create a 1:1 webchat room, and wire the channel→agent in one call.

(Without `withRoom`, the call creates a bare agent_group with no chat surface — the v2 default, since agents are entities and rooms are conversation spaces. You'd then wire the agent into a room via `POST /api/rooms` or the PWA's "+ Add agent" inside an existing room.)

Ask the user for an agent name, then offer a persona prompt with **Skip** as the recommended default — most first installs just want a working agent to talk to, and any persona can be edited later via `CLAUDE.local.md` or the PWA. There is no special first-agent role in v2 — every webchat agent has the same capabilities (see "Channel Info"), so pick a name that reflects what the agent is for.

```
AskUserQuestion: "What should we call this first agent?"
  (free-form; suggest "Helper" as the recommended option)

AskUserQuestion: "Add a custom persona / system instruction?"
  Options:
    1. Skip — use the default persona (Recommended)
    2. Yes, I'll write one
```

If the user picks **Skip**, omit `instructions` from the POST body — the handler will apply the built-in default. Only ask the follow-up persona question if they pick "Yes".

Then `curl` it (substitute the answers). The `X-Webchat-CSRF` header is required on every owner-only POST — the PWA sets it automatically; for direct `curl` calls you have to include it explicitly:

```bash
curl -s -X POST http://127.0.0.1:3100/api/agents \
  -H 'Content-Type: application/json' \
  -H 'X-Webchat-CSRF: 1' \
  -d '{"name":"Helper","instructions":"You are a helpful local assistant. Keep replies short and direct.","withRoom":true}'
```

If `WEBCHAT_TOKEN` is set, add `-H 'Authorization: Bearer <token>'`.

Confirm the response includes `"ok": true` and an `agentGroup.id` UUID. The room appears in the PWA sidebar immediately (the `broadcastRooms` event fires on creation).

> **Credentials reminder.** The agent will only respond to messages once its container can authenticate to the LLM provider. Make sure either OneCLI or the native credential proxy is set up. With OneCLI, freshly-created agents start in `selective` secret mode — if the agent connects but gets `401 Unauthorized`, run `onecli agents set-secret-mode --id <agent-group-id> --mode all` (see the v2 `CLAUDE.md` "Gotcha" section).

## Troubleshooting

### Replies arrive intermittently / `No adapter for channel type webchat` warnings in the log

You probably have multiple host processes for this checkout. `pnpm run dev` does not single-instance — a `Ctrl-C` followed by a fresh `pnpm run dev` can leave the previous node alive (especially after non-graceful kills). All those orphans run delivery polls and race for outbound messages: the orphan that loses the port bind has no webchat adapter in its `activeAdapters` map, so when it wins the race it logs `No adapter ...` and clears the outbox without delivering. The reply is gone.

Webchat's `setup()` now logs a fatal `port ${port} already in use — another nanoclaw host is likely running` line on EADDRINUSE so the second start fails loudly instead of silently joining the race. If you didn't see that line and still get intermittent silence, the duplicate started before this skill was applied.

Recovery for an existing duplicate-process state:

```bash
# kill every node process running tsx for THIS checkout
pgrep -f "$(basename $(pwd)).*tsx" | xargs -r kill -9
sleep 2
# verify just one (or zero) listener:
ss -tlnp | grep ":3100"
# start clean
pnpm run dev
```

The underlying single-instance guard in v2 trunk is tracked separately — when it lands, the second `pnpm run dev` will refuse to start at all instead of half-starting.

## Optional add-on: secure shared-room BYOK

Webchat supports **bring-your-own-key (BYOK)** — several people in one room and conversation, each billing *their own turns* to *their own* account: an Anthropic **API key** or their Claude **subscription** (OAuth). Each member's turn runs in its own container under their own OneCLI identity, so a compromised agent can't spend anyone else's key; the agent still sees the full shared conversation. It's a separate, opt-in skill and is **off by default** (rooms start with BYOK disabled).

**Offer it now — ask the operator** whether they want secure shared-room BYOK:

- If **yes**: run `/add-byok`. It requires **OneCLI** (the credential vault) — if that's not set up yet, run `/init-onecli` first. After install, BYOK is enabled per-room from Room settings.
- If **no / unsure**: skip it — they can run `/add-byok` any time later. No webchat reconfiguration is needed to add it.

Don't auto-install it; only proceed when the operator opts in.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now. Otherwise:

1. Open `http://127.0.0.1:3100/` (or your configured host:port) in a browser.
2. Use the bearer token if you set one.
3. Click into the room you just created and start chatting.

For additional agents, repeat the `POST /api/agents` call — each creates its own room.
