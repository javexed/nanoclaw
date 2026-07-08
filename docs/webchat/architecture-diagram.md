# Webchat Architecture Diagram

Webchat is a self-registering **channel adapter** — it plugs into NanoClaw's
normal router/session/delivery model exactly like Discord or Slack, but is the
only channel that also ships its own management surface (a PWA + operator
console) over an embedded HTTP + WebSocket server. This doc diagrams the
webchat-specific pieces; for the host/container/session model underneath it,
see the main [architecture diagram](../architecture-diagram.md). For the full
prose reference, see [webchat.md](webchat.md).

## System overview

```mermaid
flowchart TB
  subgraph Browser["Browser (installable PWA)"]
    UI["public/webchat/*<br/>index.html + app.js + style.css<br/>service worker (sw.js)"]
  end

  subgraph WebchatServer["Webchat Channel Adapter (src/channels/webchat/)"]
    direction TB
    HTTP["server.ts<br/>HTTP + static serve + TLS/CORS/CSP"]
    WS["ws.ts / state.ts<br/>WebSocket + broadcast"]
    Auth["auth.ts / access.ts / roles.ts<br/>4 auth methods, per-room access"]
    Adapter["index.ts<br/>ChannelAdapter: onInbound/deliver/setTyping/sendStatus<br/>loop-back fan-out, approval-card listeners"]
    Console["Operator console APIs<br/>agents, models, mcp-registry, ollama-manage,<br/>drafter, oauth-mint, push, redact"]
    Db[("db.ts / migration.ts<br/>~25 webchat tables in data/v2.db")]
  end

  subgraph Core["NanoClaw core (unchanged)"]
    Router["Router<br/>src/router.ts"]
    SessMgr["Session Manager"]
    Session[("inbound.db / outbound.db<br/>per session")]
    Container["Per-session container<br/>agent-runner"]
    Delivery["Delivery Poller"]
    Central[("Central DB<br/>data/v2.db")]
  end

  subgraph OneCLI["OneCLI Gateway"]
    Vault["Agent Vault<br/>per-member credentials"]
  end

  UI <-->|"WebSocket: message / status / broadcast"| WS
  UI -->|"HTTPS: REST"| HTTP
  HTTP --> Auth
  HTTP --> Console
  WS --> Adapter
  Auth --> Adapter
  Adapter -->|"onInbound(roomId, threadId, msg)"| Router
  Router --> SessMgr --> Session
  Session <--> Container
  Container -->|"per-turn credential lookup"| Vault
  Delivery -->|"poll"| Session
  Delivery -->|"adapter.deliver(...)"| Adapter
  Adapter -->|"store + broadcast"| Db
  Db --> WS
  Adapter -. "rate-limited loop-back<br/>re-enters router" .-> Router
  Console --> Db
  Router -. "messaging_group / agent_group wiring" .-> Central
  Db -. "webchat tables live alongside" .-> Central
```

## Message round trip

```mermaid
sequenceDiagram
  participant Br as Browser (PWA)
  participant WS as ws.ts
  participant Ad as Adapter (index.ts)
  participant Rt as Router
  participant IDB as inbound.db
  participant Ct as Container (agent-runner)
  participant ODB as outbound.db
  participant Dl as Delivery Poller
  participant Db as webchat_messages (db.ts)

  Br->>WS: {type:'message', content, thread_id}
  WS->>WS: resolve authenticated identity (senderId)
  WS->>Ad: onInbound(roomId, threadId, message)
  Ad->>Rt: routeInbound(...)
  Rt->>Rt: resolve session (agentGroup, room, threadId, mode)
  Rt->>IDB: INSERT messages_in
  Rt->>Ct: wake container
  Ct->>IDB: poll
  Ct->>Ct: run provider turn
  Ct->>ODB: INSERT messages_out
  Dl->>ODB: poll
  Dl->>Ad: deliver(roomId, threadId, msg)
  Ad->>Db: store (thread-stamped)
  Ad->>WS: broadcast to connected clients
  Ad--)Rt: rate-limited loop-back (<=30 events / 60s per room)
```

## Per-member user credentials

```mermaid
flowchart LR
  subgraph Room["Shared room"]
    MemberA["Member A's turn"]
    MemberB["Member B's turn"]
  end

  subgraph Keying["Per-member session keying"]
    KeyA["per-thread session<br/>thread_id = userId(A)<br/>trigger:1"]
    KeyB["per-thread session<br/>thread_id = userId(B)<br/>trigger:0 (fan-out, shared context)"]
  end

  subgraph Vault["OneCLI Agent Vault"]
    IdA["user-creds-&lt;slugA&gt;-&lt;hash&gt;"]
    IdB["user-creds-&lt;slugB&gt;-&lt;hash&gt;"]
  end

  MemberA --> KeyA --> IdA
  MemberB --> KeyB --> IdB
  IdA -. "bills A's own key / OAuth" .-> ProviderA["Anthropic / OpenAI"]
  IdB -. "bills B's own key / OAuth" .-> ProviderB["Anthropic / OpenAI"]

  Note["Credential types: Anthropic API key (shipped) ·<br/>Claude subscription OAuth (tested) ·<br/>OpenAI key + Codex OAuth (inert until /add-codex)"]
```

## Operator console -> REST surface

```mermaid
flowchart TB
  subgraph Console["Operator console (index.html tabs)"]
    Agents["Agents"]
    Models["Models"]
    MCP["MCP"]
    Routing["Routing<br/>(hidden until installed)"]
    Approvals["Approvals"]
    Permissions["Permissions"]
    Topology["Topology / Wiring"]
    Dashboard["Dashboard"]
  end

  Agents --> R1["/api/agents, /api/agents/draft,<br/>/:id/instructions|rooms|model|mcp-servers|status"]
  Models --> R2["/api/models, /discover /probe /bulk,<br/>/api/ollama/hosts|models|pulls"]
  MCP --> R3["/api/mcp-servers, /probe"]
  Routing --> R4["/api/router/routes|classify|decisions|metrics|install,<br/>/api/litellm/roster-refresh"]
  Approvals --> R5["/api/approvals/pending, /:id/respond"]
  Permissions --> R6["/api/users, /api/permissions/grant|revoke"]
  Topology --> R7["/api/topology, /api/rooms/:id/agents"]
  Dashboard --> R8["aggregate: health, agents, sessions,<br/>containers, router metrics"]
```

## Local-model routing install (one click)

```mermaid
flowchart LR
  Btn["'Set up routing' button<br/>(Settings)"] -->|"POST /api/router/install"| Install

  subgraph Install["startRoutingInstall()"]
    Pull["Pull classifier model<br/>Arch-Router (Ollama)<br/>progress bar"]
    Script["install-routing.sh<br/>seed routes.json, LiteLLM container"]
    Host["configureClassifierHost()<br/>CLASSIFIER-HOST -> host.docker.internal"]
    Bind["bind-routes.mjs --apply<br/>bind capability routes to roster"]
  end

  Install --> Routes[("routes.json<br/>shadow mode: live.enabled = false")]
  Routes --> Tab["Routing tab appears<br/>Rules / Logs sub-tabs"]
  Tab -->|"operator reviews decisions log"| Live["flip live from the tab"]
```

---

*Two-DB session split and central-DB model are unchanged by webchat — it's a
consumer of them, not a new IO path. See
[../architecture-diagram.md](../architecture-diagram.md) for that part of the
picture.*
