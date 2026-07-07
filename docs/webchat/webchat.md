# Webchat channel — architecture & feature reference

The webchat channel is a self-registering **channel adapter** that serves an
installable PWA and a full **operator console** from an embedded HTTP + WebSocket
server. It is the only channel that ships its own management surface; everything
else routes through NanoClaw's normal entity model (users → messaging groups →
agent groups → sessions), exactly like Discord/Slack/Telegram.

This is the overview. Focused design docs cover the harder subsystems in depth:

- Threads: [webchat-threads.md](webchat-threads.md), [webchat-threads-qa.md](webchat-threads-qa.md)
- Thread context sync: [webchat-thread-context-sync.md](webchat-thread-context-sync.md)
- Thread-engaged agents (dormant): [thread-engaged-agents.md](thread-engaged-agents.md)
- Per-member credentials (BYOK): [user-credentials.md](../design/user-credentials.md), [user-credentials-oauth.md](../design/user-credentials-oauth.md)
- Local-model routing: [llm-router.md](../design/llm-router.md), [add-litellm.md](../design/add-litellm.md)

Ships **disabled by default** — the adapter factory returns `null` unless
`WEBCHAT_ENABLED=true`.

## Architecture

### How it plugs into NanoClaw

`registerChannelAdapter('webchat', …)` in `src/channels/webchat/index.ts` registers
a factory that builds the adapter only when enabled. The adapter declares
`supportsThreads: true`, so — unlike Chat-SDK-bridged channels — it preserves
`threadId` end to end. From the router's perspective it is an ordinary
`ChannelAdapter` with `onInbound` / `deliver` / `setTyping` / `sendStatus`.

### Message flow (round trip)

1. **Browser → adapter.** The PWA sends a WebSocket frame
   `{type:'message', content, thread_id}`. `ws.ts` resolves the authenticated
   identity and calls `onInbound(roomId, threadId, message)`. Sender identity and
   access gating are enforced downstream in the router / permissions module from a
   `senderId` carried on the message.
2. **Router → session.** The router resolves a session for
   `(agentGroup, room, threadId, mode)` and writes into that session's
   `inbound.db`; the per-agent-group container is woken.
3. **Agent → outbound.** The container writes replies into `outbound.db`.
4. **Delivery → browser.** Host delivery polls `outbound.db` and calls
   `adapter.deliver(roomId, threadId, msg)`, which stores the reply in
   `webchat_messages` (thread-stamped) and `broadcast`s it over WebSocket to
   connected clients. A rate-limited **loop-back** re-enters the router so other
   agents wired to the room can react (bounded to ~30 events / 60 s per room).

The two-DB session split and central-DB model are unchanged — webchat is a
consumer of them, not a new IO path. `webchat_messages` is a PWA-facing history
mirror; routing and delivery still flow through `inbound.db` / `outbound.db`.

### Storage

A webchat-owned set of ~25 tables in the central DB (`data/v2.db`), created by
`src/channels/webchat/migration.ts`: rooms, messages (+ an FTS5 external-content
mirror `webchat_messages_fts`), threads, thread reads/sync, room settings/primes/
pins/reads/archives, models + per-agent assignments, MCP servers + per-agent
attachments, push subscriptions, user handles, an approvals index, and settings.

### Credential injection

Credentials are never placed in env vars or chat. Per-turn credentials are
injected on the wire by the **OneCLI gateway**, keyed to the container's OneCLI
agent identity, resolved at spawn from trusted session state. See the BYOK
section and [user-credentials.md](../design/user-credentials.md).

### Approvals bridge

The adapter registers approval listeners so credentialed-action approval cards
surface both in the requesting agent's room and in per-approver DM "inboxes"
(synthetic `approvals:<handle>` messaging groups). Cards clear live on first
response.

## Feature catalog

### Chat

- **Rooms / lobby** — sidebar room list with search, A–Z / recent sort, create,
  per-room color; pin / archive / hide / drag-reorder.
- **@mention routing** — mention autocomplete from a room's mentionable set.
  Rooms are **mention-only**: an agent replies only when @-mentioned. A per-room
  **prime** agent acts as a catch-all; a per-room engage mode governs stickiness.
- **Per-agent DMs** — single-agent `dm:<folder>` rooms.
- **Threads** — a thread *is* an agent session (`resolveSession(…, 'per-thread')`),
  so each `(room, thread)` has isolated context and its own `inbound.db` /
  `outbound.db`. Sidebar-nested tree; `main` is pinned and non-deletable; manual
  create / rename / delete; per-thread unread; active-thread persistence.
  (Auto-spawn was cut — only a dormant column remains.)
- **Thread context sync** — pull or push a verbatim, additive, incremental slice
  of one thread's history into another, with per-direction high-water marks so
  re-syncs never duplicate; imported spans render as labelled context dividers.
- **Markdown** — GFM via vendored `marked` + `DOMPurify`; code-block copy toolbars.
- **Attachments** — small uploads plus chunked/resumable uploads above ~512 KB;
  image bubbles with a pinch-zoom lightbox; files stored as separate message rows.
- **Live agent activity** — redacted `status` frames stream a per-turn thinking
  bubble (`start` / `tool` / `progress` / `reasoning` / `done` / `stalled`) with an
  elapsed timer, expandable full trace, typing indicator, and an **interrupt**.
- **Search** — SQLite **FTS5** external-content virtual table with sync triggers,
  prefix matching, and `snippet()` highlighting; jumps to a match, paging history
  as needed.
- **Notifications / PWA** — Web Push (VAPID) with an SSRF-allowlisted endpoint set;
  a service worker (network-first shell, cache-first vendored libs, `/api` & `/ws`
  bypass) for an installable, offline-capable app; IndexedDB unread app-badge.
- **Themes** — dark / light / system, font scale, send-key preference; design
  tokens per [`public/webchat/DESIGN.md`](../../public/webchat/DESIGN.md).

### Security & identity

- **Localhost-first binding** — default `127.0.0.1:3100`; refuses a non-loopback
  bind unless an explicit auth method is configured.
- **Authentication** — four methods, each auto-enabled by the presence of its env
  var and tried in priority order (see table below). There is no mode selector;
  localhost auto-owner is disabled once any explicit method is configured.
- **Roles** — owner / admin, global or scoped to an agent group; the first
  authenticated identity is auto-granted global owner. Fails open to a single
  trusted operator when the permissions module isn't installed.
- **Per-room access gating** — a user can access a room if they can access any
  agent group wired to it.
- **CSRF / CORS / CSP** — mutating routes require an `X-Webchat-CSRF: 1` header
  (else 403), plus same-origin CORS echo, strict CSP, `X-Frame-Options: DENY`,
  nosniff.
- **SSRF guards** — every operator-supplied URL (model / Ollama / MCP probes) goes
  through `assertSafeOutboundUrl` / `safeFetch`: rejects non-http(s) and
  cloud-metadata hosts, always blocks link-local `169.254/16`; private / RFC1918 /
  loopback allowed by default (legit LAN Ollama), blocked under
  `WEBCHAT_BLOCK_PRIVATE_IPS=true`.
- **Redaction** — `redactSensitiveData` masks Anthropic / OAuth / GitHub / AWS /
  Slack / Discord / Azure keys, PEM blocks, connection strings, and env secrets
  before any broadcast or push payload.
- **TLS** — optional `WEBCHAT_TLS_CERT` / `_KEY` upgrade to HTTPS.

### BYOK — per-member credentials

In a shared room, each member's turns run in a container bearing that member's own
OneCLI agent identity, so the gateway bills that member's own credential. Per-member
session keying uses `per-thread` with `thread_id = userId`; shared context is
preserved by fan-out (sender `trigger:1`, others `trigger:0`).

- **Credential types** — Anthropic API key (`sk-ant-…`), Claude subscription OAuth
  token, OpenAI API key, Codex ChatGPT subscription. The **API-key path is
  shipping**; the **OAuth / subscription minting flow is a prototype**
  (`oauth-mint.ts` screen-scrapes `claude setup-token` / `codex login` output via a
  PTY — fragile, untested). Codex / OpenAI types are inert until `/add-codex`.
- **Storage / injection** — credentials go straight to the OneCLI vault (the host
  never holds them); the per-member agent id is a deterministic
  `user-creds-<slug>-<hash>`. Approval reversal is tracked in
  `user_credential_members`.
- **Per-room gating** — `credential_mode` (disabled / optional / required, default
  disabled) + an `oauth_allowed` toggle; a workspace policy sets the default mode
  and which credential types are permitted (out of the box: Anthropic key only).
  Onboarding is bound to the authenticated `userId`, room-access + CSRF gated, and
  rate-limited.

### Operator console

- **Agents** — CRUD, wire to rooms, edit instructions, status (active / paused /
  archived), assign a model, attach MCP servers, and **draft from a prompt**
  (`POST /api/agents/draft` calls Anthropic host-side via OneCLI and returns a
  `{name, instructions}` suggestion — it does not create). The settings panel is a
  two-tab layout: **Settings** (status pills, name, a model picker showing the
  agent's auto-detected model when none is assigned, and MCP-servers / Rooms attach
  accordions driven by one shared bottom-sheet picker) and an **Instructions**
  sub-tab. Clicking an agent in a room's settings — or a room in an agent's — jumps
  straight to that entity.
- **Models** — register `anthropic` / `ollama` / `openai-compatible`; live
  discover / probe (races http/https + Ollama, classifies the provider); bulk
  register; per-agent assignment writes an env override into the group's
  `settings.json` (containers read it on their next spawn). `openai-compatible`
  requires `/add-opencode`.
- **Ollama host management** — list hosts, stream model **pulls** with progress,
  refresh the router roster.
- **Local-model routing** — a console over a LiteLLM + Arch-Router classifier stack.
  A **"Set up routing"** button in Settings installs and configures it in one flow
  (`POST /api/router/install`: pulls the classifier model with a progress bar, runs
  the `add-routing` installer, points the classifier at `host.docker.internal`, and
  auto-binds routes to the roster) — no shell required; it can still be installed via
  `/add-litellm` + `/add-routing` instead. Once installed the **Auto routing tab** appears
  (hidden until `routes.json` exists) with **Rules**, **Models**, and **Logs** sub-tabs: a routes
  editor with a live **test bench** and per-route suggestions when a roster model has
  an uncovered capability, a **decisions tail** (`routing-shadow.jsonl`) and
  shadow-vs-live **metrics**, the router roster, and a roster-refresh that re-runs
  the installers and re-binds. A **router picker** (New / Delete) defines multiple
  named routing profiles (`auto`, `auto-vision`, …) sharing one classifier + roster;
  the sub-tabs operate on the selected profile, and an agent picks one by its assigned
  virtual model. Starts in **shadow mode**; the operator flips it live
  from the tab. Degrades cleanly to "not installed" when `data/litellm/*` is absent.
- **MCP registry** — register / probe (real MCP client, lists tools) / assign MCP
  servers to agents; syncs into `container_configs.mcp_servers`, co-existing with
  `ncl`-added servers.
- **Approvals inbox** — pending list + respond; in-room and per-approver cards.
- **Permissions** — user list, role grants/revokes, per-agent-group admin/member
  matrix (role grants owner-only; member grants delegable to scoped admins).
- **Topology & Wiring** — a Rooms→Agents→Models graph and a rooms×agents matrix.
- **Dashboard** — health strip, message-activity metrics, container/agent
  drill-downs, uptime, and a "Router · last 7 days" panel when routing is installed.

## Authentication methods

No mode selector — each method auto-enables from its env var, tried in priority
order. Localhost auto-pass is off once any explicit method is set.

| Method | Env var(s) | Detection | Identity |
|---|---|---|---|
| Bearer | `WEBCHAT_TOKEN` (≥24) | `Authorization: Bearer` or WS subprotocol `bearer.<t>`; constant-time compare | `webchat:owner` |
| Trusted-proxy / SSO | `WEBCHAT_TRUSTED_PROXY_IPS` (`auto`/`*`/CIDR list), `WEBCHAT_TRUSTED_PROXY_HEADER` | `auto`/`*` trusts Azure EasyAuth / Cloudflare Access paired headers (presence only) or the header from any IP; else source IP must match the allowlist | `webchat:<identity>` |
| Tailscale | `WEBCHAT_TAILSCALE=true` | `tailscale whois --json <ip>` → `LoginName` | `webchat:tailscale:<email>` |
| Localhost | _(none)_ | remote is loopback **and** no explicit method configured | `webchat:local-owner` |

## Environment variables

Loaded from `.env` into `process.env` (if unset) by the adapter's `env-load.ts`
(service runners don't inherit `.env`).

| Var | Meaning | Default |
|---|---|---|
| `WEBCHAT_ENABLED` | Enable the adapter (else the factory returns null) | off |
| `WEBCHAT_HOST` | Bind host | `127.0.0.1` |
| `WEBCHAT_PORT` | Bind port | `3100` |
| `WEBCHAT_TOKEN` | Bearer secret (≥24 chars) | `''` |
| `WEBCHAT_TAILSCALE` | `=true` enables Tailscale-whois auth | off |
| `WEBCHAT_TRUSTED_PROXY_IPS` | `auto`/`*` or CSV IP/CIDR allowlist → enables proxy/SSO auth | `''` |
| `WEBCHAT_TRUSTED_PROXY_HEADER` | Header carrying the proxy identity | `x-forwarded-user` |
| `WEBCHAT_TLS_CERT` / `WEBCHAT_TLS_KEY` | Enable HTTPS (both required) | unset |
| `WEBCHAT_PUBLIC_DIR` | PWA static dir | `public/webchat` |
| `WEBCHAT_VAPID_PUBLIC_KEY` / `_PRIVATE_KEY` | Web-Push VAPID keys (push off if unset) | unset |
| `WEBCHAT_VAPID_SUBJECT` | VAPID subject | `mailto:admin@example.com` |
| `WEBCHAT_DRAFTER_MODEL` | Model for draft-from-prompt | `claude-haiku-4-5` |
| `WEBCHAT_BLOCK_PRIVATE_IPS` | `=true` extends the SSRF block to loopback/RFC1918/CGNAT | off |
| `OLLAMA_HOST` | Dashboard "is Ollama up" probe only | `''` |

## REST endpoints (by area)

- **Health / auth / identity** — `GET /health`, `GET /api/auth/info`,
  `GET /api/auth/check`, `GET|PUT /api/me/handle`.
- **Rooms** — `GET|POST /api/rooms`, `DELETE /api/rooms/:id`,
  `GET /api/rooms/:id/agents` + `POST` (wire) + `DELETE …/agents/:aid`,
  `GET /api/rooms/:id/mentionable`, `PUT|DELETE …/prime`,
  archive/hide/pin variants, `POST /api/rooms/pins/order`,
  `GET|PUT …/engage-mode`, `PUT …/name`.
- **Threads** — `GET|POST /api/rooms/:id/threads`,
  `GET|PUT|DELETE …/threads/:tid`, `PUT …/threads/:tid/read`,
  `POST …/threads/:tid/pull|push` (dormant: `…/engaged` routes).
- **Credentials / BYOK** — `GET|PUT /api/webchat/credentials-config`,
  `GET|POST|DELETE /api/user-credentials/credential`,
  `POST /api/userCreds/oauth/(start|code|cancel)`,
  `POST /api/userCreds/codex/(start|finish|cancel)`,
  `GET|PUT /api/rooms/:id/credential-mode`, `GET|PUT /api/rooms/:id/oauth-allowed`.
- **History / files / search** — `GET /api/rooms/:id/messages` (`?thread_id=`),
  `POST /api/rooms/:id/upload`, `POST /api/rooms/:id/upload/chunk`,
  `GET /api/files/:roomId/:fileId`, `GET /api/search`, `GET /api/topology`.
- **Agents** — `GET|POST /api/agents`, `POST /api/agents/draft`,
  `GET|PUT|DELETE /api/agents/:id`, `PUT …/instructions`, `GET|PUT …/rooms`,
  `PUT …/model`, `GET|PUT …/mcp-servers`, `PUT …/status`.
- **MCP** — `GET|POST /api/mcp-servers`, `POST /api/mcp-servers/probe`,
  `PUT|DELETE /api/mcp-servers/:id`.
- **Models / Ollama / router** — `GET|POST /api/models`,
  `POST /api/models/discover|probe|bulk`, `PUT|DELETE /api/models/:id`,
  `GET /api/ollama/hosts|models|pulls`, `POST /api/ollama/pull`,
  `GET|PUT /api/router/routes`, `POST /api/router/classify`,
  `GET /api/router/decisions|metrics|models`, `GET|POST /api/router/install`,
  `GET|POST /api/litellm/roster-refresh`.
- **Approvals / permissions / push** — `GET /api/approvals/pending`,
  `POST /api/approvals/:id/respond`, `GET /api/users`, `DELETE /api/users/:id`,
  `POST /api/permissions/grant|revoke`, `GET /api/push/vapid-public`,
  `POST /api/push/subscribe|unsubscribe`. Plus static PWA serve + WS upgrade.

## File layout

Adapter (`src/channels/webchat/`):

| File | Role |
|---|---|
| `index.ts` | Adapter registration; `onInbound` / `deliver` / `setTyping` / `sendStatus`; loop-back fan-out; approval-card listeners |
| `server.ts` | The HTTP server: manual route dispatch, static serve, WS upgrade, TLS, CORS/CSP |
| `ws.ts` / `state.ts` | WebSocket handling; `broadcast` + per-user approval push |
| `auth.ts` / `access.ts` / `roles.ts` | The four auth methods; per-room access; owner/admin roles |
| `db.ts` | All webchat table CRUD, thread/sync helpers, FTS search, approvals index, models/MCP |
| `migration.ts` | The ~25 webchat tables |
| `models.ts` / `ollama-manage.ts` | Model registry + SSRF policy + env injection; Ollama pull + router state |
| `mcp-registry.ts` / `mcp-probe.ts` | MCP registry + probe |
| `drafter.ts` / `oauth-mint.ts` | Host-side agent drafter; browser OAuth/Codex mint (prototype) |
| `push.ts` / `redact.ts` / `reconcile.ts` / `env-load.ts` | Web Push + allowlist; secret masking; delivery-race recovery; `.env` shim |

PWA (`public/webchat/`): `index.html` (all views/modals), `app.js` (behavior),
`style.css`, `sw.js`, `manifest.json`, `DESIGN.md` (design-language contract),
vendored `marked.min.js` / `dompurify.min.js`, icons/logos.

Cross-cutting: `src/modules/user-credentials/`, `src/modules/agent-status/`,
migrations `src/db/migrations/020-024`.

## How it ships

Webchat is a large, opt-in channel that lives on the long-running
**`channels-webchat`** branch and installs **additively** — it is deliberately not
merged into trunk (too large a surface for core). It is installed by the
`/add-webchat` skill (or `install-webchat.sh` directly):

- **NEW_PATHS** — webchat-owned dirs (`src/channels/webchat`, `public/webchat`,
  `src/modules/user-credentials`, the agent-status module, migrations `020-024`,
  design docs, helpers) are copied wholesale.
- **HOOK_FILES** — ~48 shared trunk files (`src/router.ts`, `src/delivery.ts`,
  `src/index.ts`, `src/session-manager.ts`, `src/container-runner.ts`,
  `container/Dockerfile`, `CLAUDE.md`, …) get small, **reversible 3-way patches**.
- Migrations register into `src/db/migrations/index.ts`; pinned deps
  (`ws`, `busboy`, `web-push`, `undici`, `@modelcontextprotocol/sdk`) install; the
  host and container image build.
- `configure-webchat.sh` writes `.env` (enable flag, network mode, VAPID keys);
  `uninstall-webchat.sh` reverses every hook and removes NEW_PATHS (leaving `.env`
  and DB tables intact).

## Status: shipped vs prototype vs companion-skill

- **Shipped** (built, on `channels-webchat`): the adapter + console core, rooms /
  mentions / pins / archive, **threads**, **thread context sync**, FTS5 search, Web
  Push / PWA, the approvals bridge, the models registry + discover/probe, Ollama
  pull, the MCP registry, permissions / topology / wiring, draft-from-prompt, all
  four auth methods, SSRF / CSRF / redaction.
- **BYOK**: the **Anthropic API-key path ships**; the **OAuth / subscription +
  Codex minting flow is a prototype** (fragile PTY screen-scrape, no tests).
- **Thread-engaged agents (chips)**: built but **dormant/removed** — the backend
  tables and routes remain, but the UI was pulled and threads route mention-only.
- **Local-model routing**: the **console is shipped**, now with a one-click **"Set
  up routing"** installer in Settings (pulls the classifier, scaffolds routing, and
  auto-binds routes). The **engine** (LiteLLM + Arch-Router classifier) is still a
  separate stack — installed from that button or via `/add-litellm` + `/add-routing`;
  the console degrades to "not installed" without it.
