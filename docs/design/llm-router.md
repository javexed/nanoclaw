# LLM routing & providers (two-plane design)

Status: **design / plan** — not built. Scopes how NanoClaw supports many model
backends at once: local (localhost + LAN), self-hosted GPU, cloud-by-API-key, and
**subscription agents over OAuth** (Claude Code now; Codex on a **separate track**).

## 1. Goal & requirements

1. Add a **virtual LLM router** to NanoClaw, runnable **as a Docker container**.
2. Use **multiple LLMs**: local on **localhost**, local on the **LAN** (Ollama),
   self-hosted **GPU** (vLLM), and **cloud** models.
3. Also use **subscription agents via OAuth** — **Claude Code** (Claude Pro/Max)
   and **Codex** (ChatGPT subscription). *Codex is a separate track (`/add-codex`).*
4. Support **long-running agentic flows**.

## 2. The load-bearing constraint: two credential planes

A generic LLM router (LiteLLM, OpenRouter) speaks provider **APIs** authenticated
with **API keys**. It **cannot** drive **Claude Code** or **Codex** *subscriptions*
— that auth lives in the agent CLIs themselves (`claude setup-token` /
`CLAUDE_CODE_OAUTH_TOKEN`, Codex's ChatGPT login), which a proxy can't mint, refresh,
or present. (Reverse-engineered "subscription through a proxy" hacks are ToS-risky
and brittle — out of scope.) So the backends split into two planes:

| Plane | Backends | Auth | Routed by |
|-------|----------|------|-----------|
| **A — API / endpoint** | local Ollama, local vLLM, LAN/Tailscale models, cloud models *by API key* | bare endpoint or API key | **LiteLLM** (the router container) |
| **B — subscription agents** | **Claude Code** (Pro/Max), **Codex** (ChatGPT) | **OAuth**, per user | **native harness + OneCLI** — *not* a router |

There is **no single off-the-shelf router that covers both planes**. The design
embraces that rather than fighting it.

## 3. Two axes: harness × model-source

Every agent config is **harness × model-source** — two independent choices:

- **Harness / provider** — *who runs the agentic loop* (turns, tool calls):
  `claude` (Claude Agent SDK), `opencode`, `codex`, `mock`.
- **Model source** — *where tokens come from*: Anthropic API key, Claude
  subscription (OAuth), ChatGPT subscription (OAuth), an Ollama/vLLM endpoint, or a
  **LiteLLM endpoint** (a meta-source that itself fans out to many).

```
              HARNESS            ×   MODEL SOURCE
Plane B   Claude Agent SDK       ×   Claude subscription (OAuth)
          Codex (separate track) ×   ChatGPT subscription (OAuth)
Plane A   OpenCode               ×   LiteLLM ──┬─ Ollama (localhost)
                                               ├─ vLLM (GPU)
                                               ├─ LAN / Tailscale models
                                               └─ cloud models (API key)
```

**LiteLLM is a model source, not a harness.** It occupies the same slot the
Anthropic API endpoint occupies for the `claude` provider; `OpenCode` is the
harness that consumes it. They compose, they are not alternatives.

## 4. Architecture

NanoClaw's real top-level router is **per-agent-group provider+model selection**
(`container_configs`). Each agent group picks a plane by picking a provider+model:

```
                       ┌─────────────────────────── NanoClaw host ──────────────────────────┐
  agent group "claude" │  provider=claude   ───────────────►  Claude subscription (OAuth)    │  Plane B
  agent group "codex"  │  provider=codex    ───────────────►  ChatGPT subscription (OAuth)    │  Plane B (sep. track)
  agent group "local"  │  provider=opencode ──► LiteLLM ──┬─► Ollama (host localhost)         │  Plane A
                       │                                  ├─► vLLM (GPU box)                  │
                       │                                  ├─► LAN / Tailscale model server    │
                       │                                  └─► cloud API (key)                 │
                       └────────────────────────────────────────────────────────────────────┘
   credentials: OneCLI vault injects per-agent (OAuth tokens for Plane B; the single
   LiteLLM virtual key for Plane A). No secrets in chat or baked env.
```

- **LiteLLM** runs as one long-lived container = the Plane-A sub-router. One
  endpoint, a `model_list` of every API-keyed backend, with fallbacks, budgets,
  rate limits, and observability.
- **Plane B** stays native: the `claude` provider with `CLAUDE_CODE_OAUTH_TOKEN`
  for the Claude subscription; `codex` (separate track) for the ChatGPT
  subscription. Neither passes through LiteLLM.

## 5. Maps onto existing NanoClaw mechanisms

Most of Plane A already exists:

| Need | Already in NanoClaw |
|------|---------------------|
| Point an agent at a custom model endpoint | model kinds **`ollama`** / **`openai-compat`** with an `endpoint`; injects `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL`/`OPENAI_MODEL` into the container (`src/channels/webchat/models.ts`) |
| Reach a model server on the **host's localhost** | agent containers get `--add-host=host.docker.internal:host-gateway` on Linux (`container-runtime.ts:111`) |
| Reach **LAN / Tailscale** model servers | model-endpoint SSRF policy already allows loopback, RFC1918, CGNAT/Tailscale (`models.ts`) |
| Per-agent provider+model | `container_configs` (`provider`, `model`, endpoint) |
| Subscription OAuth (Plane B) | `CLAUDE_CODE_OAUTH_TOKEN` "OAuth mode" (`container-runner.ts:215`) + OneCLI BYOK-OAuth |

So registering LiteLLM is mostly **"add one `openai-compat` model whose `endpoint`
is the LiteLLM container"**, then pick a harness to drive it.

## 6. Networking

Three hops, all already permitted by the SSRF policy:

- **agent container → LiteLLM**: put LiteLLM on a shared Docker network and address
  it by container name, **or** `host.docker.internal:<port>` (host), **or** its
  LAN/Tailscale IP.
- **LiteLLM → Ollama on the host**: `host.docker.internal` / host LAN IP.
- **LiteLLM → vLLM / LAN model server**: direct LAN/Tailscale address.

(Apple-container runtime resolves the host differently than Docker — verify the
host alias there when not on Linux/Docker.)

## 7. Credential ownership: OneCLI vs LiteLLM

Both can mint keys/budgets; avoid double-gating. Division of labor:

- **Plane B (OAuth)** → **OneCLI only.** It already brokers `CLAUDE_CODE_OAUTH_TOKEN`
  and the BYOK-OAuth flow.
- **Plane A** → **LiteLLM owns provider keys** in its own config; NanoClaw holds a
  **single LiteLLM virtual key**, stored in the **OneCLI vault** and injected per
  request like any other secret. One key for the agent side, many keys hidden
  behind LiteLLM.

## 8. Long-running agentic flows

The **router barely affects this** — agentic capability is the **harness + model**:

- **Harness**: NanoClaw's per-session containers are already long-lived (no
  host-side idle timeout — `container-runner.ts:258`). `claude`, `codex`, and
  `opencode` are all agentic loops.
- **Model**: the dominant factor. Subscription Claude/Codex rank highest; among
  local, only strong tool-callers (Qwen-Coder, Llama 3.3, DeepSeek, etc.) do real
  agentic work.
- **Router obligations** (LiteLLM config): pass through **streaming** + **tool /
  function calls**, and set generous `request_timeout` (agentic turns are long).
  LiteLLM supports all three.

## 9. Registering LiteLLM (concrete)

1. Run LiteLLM as a container with a `config.yaml` `model_list` covering 1–2 local
   models (Ollama/vLLM) + ≥1 cloud model, a master/virtual key, and
   `stream: true` + a long `request_timeout`.
2. Add a NanoClaw model: kind **`openai-compat`**, `endpoint` = LiteLLM `/v1`,
   `model_id` = a name from the `model_list`; virtual key via OneCLI.
3. Install the harness: **`/add-opencode`** (OpenAI-native, multi-provider).
4. Wire an agent group: `provider=opencode` + that model. Prove a plain turn, then
   a tool-using (agentic) turn with a capable model.

## 10. Build sequence (each phase ends provably green)

0. **Router up** — LiteLLM container + `config.yaml`; prove `/v1/models` and one
   chat completion (incl. a streamed, tool-calling request) from the host.
1. **Reachable + registered** — reach LiteLLM from inside an agent container
   (networking); register it as a NanoClaw `openai-compat` model.
2. **Harness** — `/add-opencode`; wire an agent group → LiteLLM; prove a turn.
3. **Agentic** — prove a multi-step tool-using turn with a strong model.
4. **Hardening** — fallbacks, budgets, observability; virtual key in OneCLI vault.
5. **(separate track)** — `/add-codex` for the Codex subscription plane.

## 11. What this is explicitly NOT

- **Not** pushing subscription OAuth (Claude Code / Codex) through LiteLLM.
- **Not** replacing OneCLI — LiteLLM routes Plane-A models; OneCLI keeps brokering
  credentials (and is the *only* path for Plane B).
- **Not** OpenRouter — a hosted cloud SaaS that can't see localhost/LAN models
  (fails reqs 1–2).

## 12. Open decisions

- **Hardware / where models run** — GPU on this host (vLLM), CPU Ollama, and/or a
  separate LAN/GPU box. Drives backend choice.
- **Plane-A harness** — OpenCode (recommended, OpenAI-native) vs the Claude SDK
  pointed at a LiteLLM **Anthropic-compatible** endpoint. (OpenCode keeps Plane A
  cleanly OpenAI-shaped.)
- **Selection granularity** — per-agent-group model (today) vs per-user/per-room
  model picking (the webchat already has a models UI to build on).
- **Where LiteLLM runs** — alongside NanoClaw vs on the GPU box (affects the
  networking hop in §6).
