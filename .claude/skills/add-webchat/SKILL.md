---
name: add-webchat
description: Add an embedded HTTP + WebSocket chat server with PWA frontend. Provides a web chat interface for talking to NanoClaw agents from the browser, with bearer / tailscale / proxy-header auth and Web Push.
---

# Add Webchat

Adds an in-process chat server + PWA. Runs on its own port (default 3100); doesn't share with `webhook-server`. The PWA talks to v2's agent groups via webchat-owned room metadata, and pipes inbound chat through the standard channel-adapter path so the existing router / sessions / outbound delivery flow handles it like any other channel.

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

NanoClaw doesn't ship channel adapters in trunk. This skill copies the webchat module from the skill's own `add/` directory (the adapter is self-contained and doesn't ship on the `channels` branch — there's no Chat SDK package to wrap).

### Pre-flight (idempotent)

Skip to **Configure** if all of these are already in place:

- `src/channels/webchat/index.ts` exists
- `src/channels/index.ts` contains `import './webchat/index.js';`
- All five migrations are imported and listed in `src/db/migrations/index.ts`: `moduleWebchat`, `moduleWebchatDropRooms`, `moduleWebchatRoomPrimes`, `moduleWebchatModels`, AND `moduleWebchatApprovalsIndex`
- `ws`, `busboy`, `web-push`, AND `undici` are listed in `package.json` dependencies
- `container/agent-runner/src/destinations.ts` contains the `webchat:send-file-hint START` sentinel (step 7 patch applied)
- `src/modules/agent-to-agent/create-agent.ts` contains the `webchat:create-agent-gating START` sentinel (step 6 patch applied)

Otherwise continue. Every step below is safe to re-run.

### 1. Copy source files

`-n` skips files that already exist so re-running install won't clobber local edits to the channel module.

```bash
mkdir -p src/channels/webchat
cp -n .claude/skills/add-webchat/add/src/channels/webchat/*.ts src/channels/webchat/
mkdir -p src/modules/agent-to-agent
cp -n .claude/skills/add-webchat/add/src/modules/agent-to-agent/*.ts src/modules/agent-to-agent/
```

The `src/modules/agent-to-agent/` copy is `create-agent.test.ts` — the
test for the auth gate that step 7 patches into `create-agent.ts`. It's
ineffective without that patch.

> If you've **intentionally** changed a channel file and want install to refresh it from the skill, drop `-n`.

### 2. Copy PWA assets

```bash
mkdir -p public/webchat
cp -rn .claude/skills/add-webchat/add/public/webchat/. public/webchat/
```

### 3. Append the channel self-registration import

```bash
grep -q "channels/webchat/index.js" src/channels/index.ts \
  || echo "import './webchat/index.js';" >> src/channels/index.ts
```

### 4. Register the database migration

Edit `src/db/migrations/index.ts`. **Skip each addition if it's already present** — running install twice will otherwise produce a duplicate-import / unused-import error from `tsc` and break the build.

Add this import alongside the others (skip if `grep -q "channels/webchat/migration" src/db/migrations/index.ts` already matches):

```typescript
import {
  moduleWebchat,
  moduleWebchatDropRooms,
  moduleWebchatRoomPrimes,
  moduleWebchatModels,
  moduleWebchatApprovalsIndex,
} from '../../channels/webchat/migration.js';
```

And add all five symbols to the `migrations` array (skip individual entries that are already present — any position is fine, order is determined by name uniqueness, not array index):

```typescript
const migrations: Migration[] = [
  // ... existing entries
  moduleWebchat,
  moduleWebchatDropRooms,
  moduleWebchatRoomPrimes,
  moduleWebchatModels,
  moduleWebchatApprovalsIndex,
];
```

### 5. Install pinned packages

```bash
pnpm add ws@8.20.0 busboy@1.6.0 web-push@3.6.7 undici@7.16.0
pnpm add -D @types/ws@8.18.1 @types/busboy@1.5.4 @types/web-push@3.6.4
```

`undici` is required by `drafter.ts` for `ProxyAgent` — it routes the
agent-drafter LLM call through the OneCLI proxy. Node's built-in `fetch`
uses undici internally but doesn't expose `ProxyAgent`, so the explicit
package is needed. Undici ships its own TypeScript types — no
`@types/undici` required.

### 6. Patch a2a `create_agent` with an owner/admin auth gate

The agent-to-agent `create_agent` action lets one agent spawn another.
Without this gate, any authenticated user who can drive an agent
(via webchat or any other channel) can cause that agent to spawn
arbitrary new agents — privilege escalation. The gate reads the trusted
`senderId` from `inbound.db` (host-owned) and rejects unless the
requesting user is owner, admin-of-this-group, or a CLI client (Unix
socket carve-out).

The patch is sentinel-bounded and reversible. `REMOVE.md` calls the
inverse script.

```bash
node .claude/skills/add-webchat/install/patch-create-agent.mjs
```

Idempotent (safe to re-run; detects the sentinel and exits 0). Fails
loud if trunk's `create-agent.ts` has been reformatted upstream — in
that case re-pull main and re-run, or update the script's anchors.

Requires the **permissions module** (`src/modules/permissions/`) to be
present — it provides `isOwner` and `hasAdminPrivilege`. SKILL.md's
pre-flight already calls this out as a prerequisite for webchat.

### 7. Patch agent-runner with the send_file prompt hint

The webchat PWA inline-renders attachments (image previews, PDF previews,
syntax-highlighted code). Without a small prompt nudge, agents tend to
describe files in prose instead of calling `send_file` — which works but
the file feature goes unused. This step patches `container/agent-runner/
src/destinations.ts` to add the hint when at least one destination is a
chat surface. The patch is sentinel-bounded and reversible — `REMOVE.md`
calls the inverse script.

```bash
node .claude/skills/add-webchat/install/patch-destinations.mjs
```

Idempotent (safe to re-run; detects the sentinel and exits 0). Fails loud
if trunk's `destinations.ts` has been reformatted upstream — in that case
re-pull main and re-run, or update the script's anchors.

### 8. Build

```bash
pnpm run build
```

Build must be clean before continuing.

### 9. Rebuild the agent container image

The `destinations.ts` patch lives in agent-runner code which gets baked
into the agent container image. Without this rebuild, running agents
keep using the un-patched destinations section until their next image
refresh.

```bash
./container/build.sh
```

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
- **models (per-agent)**: a third sidebar tab "Models" lets the operator register LLM endpoints/configurations and assign them to agents. MVP supports two kinds: `anthropic` (pin to a custom Anthropic model_id, reuses the agent's existing OneCLI Anthropic credential) and `ollama` (route at a local Ollama endpoint; no auth needed, Ollama speaks the Anthropic API at `<endpoint>/v1/messages`). Health-checked on save (Ollama: `/api/tags` reachability + model-name verification). Auto-discovery available via `POST /api/models/discover`. Implementation is trunk-free — assignments are written into the per-agent `data/v2-sessions/<agent>/.claude-shared/settings.json` env block (`ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`); the SDK's user setting source applies them at startup. Effect timing: takes effect on the next container spawn for the agent. Storage: `webchat_models` + `webchat_agent_models` (1:1 PK on `agent_group_id`). Endpoints: `GET/POST /api/models`, `PUT/DELETE /api/models/:id` (DELETE returns 409 + impact list when assigned; re-POST with `?force=1` to cascade-unassign), `POST /api/models/discover`, `PUT /api/agents/:id/model { modelId | null }`. The `assigned_model_id` field is included in `GET /api/agents`. Future kinds (e.g. OpenAI-compatible) will use the `credential_ref` column to point at OneCLI secret names — out of MVP scope.
- **agent drafter (✨ Suggest from prompt)**: the three create-agent flows (Agents tab, room-create inline-new-agent, room-settings + Add agent New tab) include a freeform prompt + ✨ button. Click it and the host calls `POST /api/agents/draft { prompt }`, returning a suggested `{ name, instructions }` that populates the form for the operator to review. **Host-side LLM call** routed through the OneCLI gateway with a reserved `webchat-drafter` agent identifier (registered with OneCLI on first use, idempotent). The host never holds the raw API key — OneCLI's proxy injects auth on each call, same model containers use. Per the v2 CLAUDE.md OneCLI gotcha, the drafter identifier starts in `selective` secret mode and 401s on the first call; one-time fix: `onecli agents list` to find the internal id, then `onecli agents set-secret-mode --id <internal-id> --mode all`. Latency ~3-5s per request (network-bound, no container spawn). Owner-only.

## Known caveats (preview state)

This skill is upstream-PR scope; the following are known follow-ups:

- **PWA shape**: the shipped PWA still uses v1 field shapes inside the response envelope (`jid`, `isMain`, etc.) on `/api/agents`. Endpoint paths are v2-native; the response object keys are not. Stubs for `/api/stats` / `/api/routes` / `/api/tasks` keep the v1 dashboard pages from crashing. Cleaning the response shape (and dropping the dashboard stubs) is a follow-up.
- **Orphan-room reconciliation interaction**: the PWA's WS auth handshake calls `reconcileOrphanAgents`, which provisions a 1:1 room for any agent without one. If you delete a room but leave the agents, the next PWA connect will recreate per-agent 1:1 rooms for them. Delete the agents too if you want them gone, or accept the auto-room as the v2 default.
- **File mounts**: uploaded files land under `data/webchat/uploads/<roomId>/`. They are served via HTTP, not mounted into agent containers (v1 wrote files into the agent's group folder so the agent could `cat` them; that path doesn't generalise to v2's fan-out model). Agents that need file bytes can fetch the URL.
- **Agent creation via chat** (v1's `/api/bots/create-from-chat` "ask main to register") is dropped. Use `POST /api/agents` (agent-first) or `POST /api/rooms` (room-first) directly from the PWA.

## Create your first agent

A fresh webchat install has no agents yet, and `/init-first-agent` doesn't have a webchat code path (it's built around the DM-channel mental model that webchat doesn't share). Use `POST /api/agents` with `withRoom: true` instead — that opt-in flag tells the handler to provision the agent group, initialize the on-disk filesystem (`groups/<folder>/CLAUDE.local.md`), create a 1:1 webchat room, and wire the channel→agent in one call.

(Without `withRoom`, the call creates a bare agent_group with no chat surface — the v2 default, since agents are entities and rooms are conversation spaces. You'd then wire the agent into a room via `POST /api/rooms` or the PWA's "+ Add agent" inside an existing room.)

Ask the user for an agent name and an optional persona. There is no special first-agent role in v2 — every webchat agent has the same capabilities (see "Channel Info"), so pick a name that reflects what the agent is for.

```
AskUserQuestion: "What should we call this first agent?"
AskUserQuestion: "Optional — a one-line persona / system instruction. Leave blank for the default."
```

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

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now. Otherwise:

1. Open `http://127.0.0.1:3100/` (or your configured host:port) in a browser.
2. Use the bearer token if you set one.
3. Click into the room you just created and start chatting.

For additional agents, repeat the `POST /api/agents` call — each creates its own room.
