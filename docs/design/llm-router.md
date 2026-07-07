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

## 7. Credential ownership: OneCLI is mandatory for all agent egress

**Invariant (non-negotiable): every agent's credentialed egress goes through
OneCLI.** This is a deliberate security choice — *one* place to store, manage,
monitor, rotate, approve, and rate-limit credentials. No agent ever holds a raw
key, and nothing reaches a model provider outside the gateway:

- Containers spawn with OneCLI's `HTTPS_PROXY` + certs (`container-runner.ts:550`);
  provider keys are injected on the wire by host-pattern, never via `.env` or the
  container environment. The `claude`, `opencode`, and `codex` providers all
  already honor this (OpenCode registers provider keys in OneCLI; Codex/Claude use
  vault-served OAuth / sentinel stubs).
- **LiteLLM does NOT bypass this.** The router is just another upstream behind the
  proxy: the agent → LiteLLM hop carries a **single LiteLLM virtual key injected by
  OneCLI** (host-pattern matched, stored in the OneCLI vault). LiteLLM then holds the
  many real provider keys *behind* it — so the agent side has exactly one
  OneCLI-brokered credential and the single-pane invariant holds end to end.
- The only sanctioned exception to "through the proxy" is a **local, plaintext
  endpoint** (e.g. Ollama on `host.docker.internal`) reached via an explicit
  `NO_PROXY` bypass — no credential is involved, so there is nothing to broker.
  Routed/cloud models never qualify.

Division of labor, given the invariant:

- **Plane B (OAuth)** → **OneCLI only.** It already brokers `CLAUDE_CODE_OAUTH_TOKEN`
  and the BYOK-OAuth flow.
- **Plane A** → **LiteLLM owns the many provider keys** in its own config; the
  **agent holds one OneCLI-injected LiteLLM virtual key**. Don't double-gate —
  budgets/approvals live on whichever side owns the key for that hop.

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

## 9. Requirements & install

### 9a. OpenCode — the Plane-A harness (installed *into* NanoClaw)

Installed via `/add-opencode` (copies the payload from the `providers` branch,
wires the barrels, rebuilds the image — idempotent). Requirements:

- **Source**: `providers`-branch access (`git fetch origin providers`); additive,
  never merged.
- **Build toolchain**: Docker + ability to rebuild the agent image
  (`./container/build.sh`; `docker builder prune -f` first if the COPY cache is
  stale). **Bun** on the host — the agent-runner is a Bun package (`bun add`, not
  pnpm).
- **Two pinned versions, lock-step** (the sharp edge): `@opencode-ai/sdk@1.4.17`
  (bun dep) **and** `opencode-ai@1.4.17` CLI (Dockerfile `ARG` + a pnpm-global
  layer — *not* `bun install -g`, to respect the supply-chain policy). SDK and CLI
  **must match**; `latest`/1.14.x has a breaking session-API change and won't work.
- **3-barrel wiring** + registration-guard tests (host `src/providers/index.ts` and
  container `container/agent-runner/src/providers/index.ts`).
- **Existing-group overlay propagation**: copy the provider files into each
  `data/v2-sessions/<group>/agent-runner-src/providers/` overlay — it overrides the
  image, so old groups won't see OpenCode otherwise.
- **To use** (config, not install): `agent_provider=opencode` + the
  `OPENCODE_PROVIDER`/`OPENCODE_MODEL`/`OPENCODE_SMALL_MODEL`/`ANTHROPIC_BASE_URL`
  env + the provider key in **OneCLI** by host-pattern.

OpenCode connects to cloud (Anthropic, OpenAI, Google, DeepSeek, OpenRouter, Zen)
**and** any endpoint (Ollama/vLLM/LiteLLM) directly — so it is required for a
Plane-A agent at all, but does **not** itself require LiteLLM.

### 9b. LiteLLM — the router (external container, optional)

Only needed for the fleet-management tier (fallback/budgets/one-key/observability);
OpenCode runs direct-to-provider without it. Requirements:

- **Docker**; **no GPU** (it's a proxy, not an inference server).
- **Pinned image** (e.g. `ghcr.io/berriai/litellm:<tag>`) — a separate container,
  outside the pnpm supply-chain gate, so pin deliberately.
- **`config.yaml`** = the model registry: a `model_list` mapping name →
  `{ model, api_base, api_key }`, fallback/load-balance groups, `stream: true`, a
  long `request_timeout`. The **real provider keys live here, behind LiteLLM**.
- **Networking both ways**: reachable *from* agent containers (shared Docker network
  / `host.docker.internal` / LAN) and *to* its backends (cloud + local Ollama/vLLM).
- **One LiteLLM virtual key in OneCLI** (host-pattern = the LiteLLM host) — the
  agent's single brokered credential (§7).
- **Tier gate** — this decides the footprint:

  | Want | Needs |
  |------|-------|
  | routing, **fallback**, load-balance, protocol-normalization | `config.yaml` only — no DB |
  | **virtual keys, budgets, spend caps, per-key rate-limits** | a **Postgres** DB (`DATABASE_URL`) |
  | **observability / logging** | a logging callback/sink (console/file or Postgres/Langfuse-style) |

### 9c. Dependency order

OneCLI (present) → **`/add-opencode`** (harness) → *optionally* stand up LiteLLM and
point the harness at it. Stop after OpenCode for direct-to-provider; add the router
only when the management benefits (fallback / budgets / observability) are
worth a container (+ Postgres).

## 10. Registering LiteLLM (concrete)

1. Run LiteLLM as a container with a `config.yaml` `model_list` covering 1–2 local
   models (Ollama/vLLM) + ≥1 cloud model, a master/virtual key, and
   `stream: true` + a long `request_timeout`.
2. Add a NanoClaw model: kind **`openai-compat`**, `endpoint` = LiteLLM `/v1`,
   `model_id` = a name from the `model_list`; virtual key via OneCLI.
3. Install the harness: **`/add-opencode`** (OpenAI-native, multi-provider).
4. Wire an agent group: `provider=opencode` + that model. Prove a plain turn, then
   a tool-using (agentic) turn with a capable model.

## 11. Build sequence (each phase ends provably green)

0. **Router up** — LiteLLM container + `config.yaml`; prove `/v1/models` and one
   chat completion (incl. a streamed, tool-calling request) from the host.
1. **Reachable + registered** — reach LiteLLM from inside an agent container
   (networking); register it as a NanoClaw `openai-compat` model.
2. **Harness** — `/add-opencode`; wire an agent group → LiteLLM; prove a turn.
3. **Agentic** — prove a multi-step tool-using turn with a strong model.
4. **Install skill** — `/add-litellm` (config.yaml, same-host container, OneCLI
   virtual key, optional Postgres), surfaced by the webchat install when OpenCode is
   detected (§15).
5. **Management UX** — webchat **v1** link to LiteLLM `/ui`; **v2** passthrough to
   `/model/new` etc. (§14).
6. **Hardening** — fallbacks, budgets, observability; virtual key in OneCLI vault.
7. **(separate track)** — `/add-codex` for the Codex subscription plane.

## 12. What this is explicitly NOT

- **Not** pushing subscription OAuth (Claude Code / Codex) through LiteLLM.
- **Not** replacing OneCLI — LiteLLM routes Plane-A models; OneCLI keeps brokering
  credentials (and is the *only* path for Plane B).
- **Not** OpenRouter — a hosted cloud SaaS that can't see localhost/LAN models
  (fails reqs 1–2).

## 13. Open decisions

- **Hardware / where models run** — GPU on this host (vLLM), CPU Ollama, and/or a
  separate LAN/GPU box. Drives backend choice.
- **Plane-A harness** — OpenCode (recommended, OpenAI-native) vs the Claude SDK
  pointed at a LiteLLM **Anthropic-compatible** endpoint. (OpenCode keeps Plane A
  cleanly OpenAI-shaped.)
- **Selection granularity** — per-agent-group model (today) vs per-user/per-room
  model picking (the webchat already has a models UI to build on).
- **Routing approach** — **decided: N-way capability routing (Arch-Router) + Claude
  escalation, with a self-improvement feedback loop as a later phase (§16).** Not
  binary strong/weak.
- **Where LiteLLM runs** — **decided: same host as NanoClaw.** Agent containers
  reach it at `host.docker.internal:<port>`; LiteLLM reaches local Ollama/vLLM on the
  host's `localhost` (§15 networking).
- **Model-management UX** — **decided: both v1 (link) and v2 (passthrough), phased**
  (§14).
- **Install integration** — **decided: a `/add-litellm` skill, offered by the
  webchat install when OpenCode is detected** (§15).

## 14. Model-management UX (decision)

Requirement (operator): manage LiteLLM's `model_list` **from the webchat GUI**, or —
at minimum — a **link to LiteLLM's own admin UI**. LiteLLM already ships an admin UI
at **`/ui`** (models, virtual keys, budgets, logs). **Decided: both, phased** — ship
v1, then v2:

- **v1 — Link out (low effort, full capability).** A link/button in webchat (Models
  area / settings) that opens LiteLLM's `/ui`. LiteLLM stays the source of truth for
  its own `model_list`/keys/budgets; webchat reimplements nothing.
- **v2 — In-webchat passthrough (more work).** A thin webchat surface that calls
  LiteLLM's management API (`POST /model/new`, `/model/delete`, `/model/info`) so a
  router model is added without leaving webchat. Needs LiteLLM's admin/master key —
  brokered through OneCLI like any other secret.

**Credential tension (ties to §7).** LiteLLM holding the **real provider keys behind
it** is a *second* credential store, which rubs against the single-pane invariant.
Proposed boundary: **agent-side = one OneCLI virtual key (invariant holds end to
end); provider-side keys = managed in LiteLLM** (its UI/API) as a deliberate,
monitored store behind the router. Stricter alternative: have OneCLI inject even
LiteLLM's backend keys at config time (more complex). A §7-strictness call.

**Not the same as today's webchat Models UI,** which registers a *webchat* model
pointing at an endpoint (the agent-selection side). v1/v2 here manage *LiteLLM's*
backends. They can converge later into one Models surface that both registers the
agent's endpoint and manages the router behind it.

## 15. Install integration (decision)

LiteLLM installs as its **own skill** (`/add-litellm`), *surfaced* by the webchat
install when OpenCode is detected — **not** baked into the webchat installer.
Rationale: LiteLLM's real dependency is **OpenCode (the harness)**, not webchat (the
channel); webchat is just where it's *managed* (§14), so a sensible place to *offer*
it.

- **`/add-litellm` (new skill)** — idempotent installer: writes a starter
  `config.yaml`, runs the LiteLLM container **same-host** on a port (e.g. `:4000`),
  registers the LiteLLM **virtual/master key in OneCLI** by host-pattern, optionally
  stands up **Postgres** (for the v2 keys/budgets tier), and writes the webchat
  wiring (LiteLLM endpoint + admin-key secret id) so the v1 link and v2 passthrough
  work. Independently runnable anytime.
- **Detection-gated prompt** — the webchat install (`add-webchat` /
  `install-webchat.sh`, which already has a `provider_connected()` detection gate)
  checks for OpenCode (`src/providers/opencode.ts` + barrel import, or any group with
  `provider=opencode`); if present and LiteLLM isn't installed, it offers
  `/add-litellm`.
- **Install-order robustness** — mirror the same offer in `/add-opencode` (detect
  webchat), so it fires whether OpenCode is added before or after webchat. The skill
  is the single source of truth; both entry points just call it.

**Same-host networking** (placement decision, §13): LiteLLM listens on the host;
agent containers reach it at `host.docker.internal:<port>` (the `--add-host` alias is
already wired), with the virtual key injected by OneCLI's proxy via host-pattern;
LiteLLM reaches Ollama/vLLM on the host's `localhost`. No new networking primitives.

## 16. Routing & fallback

Three layers, cheapest first. The first two keep work in Plane A; the third crosses
to Claude (Plane B). Routing is **pre-flight** (score the prompt, then run); a
**post-flight** quality judge is a later opt-in (§16d).

### 16a. Plane-A routing (LiteLLM, native)

Name-based routing + load-balance (`simple-shuffle`/`least-busy`/`usage`/`latency`),
retries, `fallbacks` / `context_window_fallbacks` / `content_policy_fallbacks`, and
cooldowns for unhealthy deployments. Handles "this Plane-A model errored → try
another" with **config only** — no custom code.

### 16b. Classifier — N-way capability routing (custom, alongside LiteLLM)

Operator requirement: **rank the prompt against model capability profiles**, not
binary strong/weak (RouteLLM is rejected for being binary).

- **Arch-Router (~1.5B, open weights, Katanemo)** as the route-classifier, self-hosted
  **alongside LiteLLM** (a LiteLLM custom routing strategy / pre-call hook). It maps a
  prompt to a **capability route** you define (code / vision / long-context /
  hard-reasoning / …); each route is **bound to a model**. Decoupled from model
  identity (swap the model behind a route), transparent (human-defined routes), small/
  cheap per turn. Verify the current model/version before building.
- **Benchmark-seeded capability table** (HF Open LLM Leaderboard, LMArena Elo,
  Artificial Analysis, MMLU/HumanEval/MMMU, context window, $/tok) informs the
  **route→model bindings** and the confidence floor — *not* consumed live by the router.
- **No single model ingests arbitrary leaderboard numbers + a prompt and ranks** —
  trained routers learn a fixed roster. So this is realized as *route-classifier +
  curated bindings* (above), or a *trained per-model predictor* on your roster (heavier).
- Alternatives: **semantic-router** (embedding buckets, nothing to host — lighter);
  **trained predictor** (RouterDC / ZOOTER / GraphRouter / Routoo — needs
  `(prompt→per-model outcome)` data; later/heavier); **commercial** (NotDiamond /
  Unify / Martian — capability routing as a service, but can't drive Claude OAuth, so
  **decision-only**, which is why self-hosted Arch-Router is cleaner here).

### 16c. Cross-plane escalation (→ Claude, Plane B)

- The router includes a **`claude` route** and/or a **confidence floor**: if the top
  Plane-A route scores below the bar, the plugin **raises a distinct
  `no_adequate_model` error**.
- Arch-Router/LiteLLM **cannot call Claude OAuth**, so escalation surfaces to
  **NanoClaw**, which switches `provider=claude` for the turn (a per-agent-group
  **`fallback_provider`**). The **same seam** also fires on **hard failure** (provider
  exchange status `error`/`undelivered`, timeout, LiteLLM down).
- **The escalation Claude model is GUI-selectable today**: assign an `anthropic`-kind
  model in the webchat Models UI ("Anthropic (custom model id)") → it sets
  `ANTHROPIC_MODEL` for the group. Caveats: validated against `KNOWN_ANTHROPIC_MODELS`
  (a new model needs a one-line add); the model must be on the credential's plan.
- Mechanics: **fresh Claude session** (OpenCode's continuation can't transfer;
  optionally seed context via `syncSessionContext`); **one-shot guard** (no ping-pong);
  double-latency + Claude-quota cost on escalation — a **backstop, not a routine path**.
  Trigger on **hard failure / below-threshold only**, never on a content-quality
  judgment (that's §16d).

### 16d. Post-flight quality judge (later, opt-in)

Judge the *answer* (not the prompt) and escalate if inadequate. Needs a judge call →
expensive and unreliable. Keep conservative, opt-in; **not in the first build**.

### 16e. Self-improvement (feedback loop) — later phase

**Not automatic.** A loop you build: log decisions + outcomes → **offline/batch**
recalibrate/retrain → redeploy (live per-request learning is unstable, avoided). Two
tiers, very different cost:

- **Threshold recalibration** (cheap, frequent, no training) — adjust the confidence
  floor / escalation rate from observed behavior ("escalating 45% but quality
  plateaued at 30% → raise the floor"). A nightly script over logs. The early win.
- **Router retraining** (periodic) — fine-tune Arch-Router / retrain the predictor on
  accumulated `(prompt → outcome)` labels for your domain + roster.

**Label sources** (best → noisiest):

- explicit 👍/👎, "regenerate", "that's wrong";
- **the free Claude-escalation outcomes** — when NanoClaw fell back to Claude, was it
  accepted / clearly better? → "this prompt needed strong"; local accepted →
  "adequate". *Your fallback path generates training data for free.*
- implicit signals (re-ask, edit, abandon);
- offline **LLM-judge** comparing local vs Claude on sampled prompts.

**Counterfactual / bandit problem (the hard part):** you observe the outcome only for
the route you *took* — not how the unchosen models would have done. To learn about
alternatives, add **ε-exploration** (occasionally route off-top) or **shadow runs**
(send a sampled %, through two models and compare), or off-policy correction. Without
it the router just reinforces its current habits.

**Sequence:** static routing → log decisions+outcomes → recalibrate threshold first →
add ε-exploration → only then periodic router retrain.

**Caveats:** noisy/biased signal; model + benchmark **drift** (keep the loop running);
**selection bias** without exploration; **prompt-logging privacy/retention** — decide
up front, it touches the single-pane/monitoring stance (§7).

### 16f. Build order (within this section)

0. Static Arch-Router routes + fixed floor; LiteLLM Plane-A fallback (16a).
1. `no_adequate_model` error + NanoClaw `fallback_provider` escalation (16c); also the
   hard-failure path.
2. GUI-selectable Claude escalation model — *already exists* (anthropic kind, §16c).
3. Log decisions + outcomes (esp. the free escalation labels).
4. Threshold recalibration (16e tier-1).
5. ε-exploration, then periodic router retrain (16e tier-2).
6. *(opt-in, later)* post-flight quality judge (16d).

### 16g. Multiple routers — reusable routing profiles (shipped)

The classifier of 16b is one **routing profile**. Several can coexist: a
`routes.json` may define **many named routers**, each with its own routes and
bindings, all sharing the **one** Arch-Router classifier and the **one** roster.
They differ only in their rules (what a route means) and bindings (which model
each route maps to).

An agent selects a profile by **which virtual model it's assigned** — same
LiteLLM `:4000` endpoint, a different model name (`auto`, `auto-vision`,
`auto-cheap`, …). The pre-call hook keys `data["model"]` against the routers map
and classifies against **that** router's routes; escalation (16c), the decision
log, binder, and recalibration are all per-router (log lines carry a `router`
field). This is how, e.g., a vision-first agent and a cost-first agent run off
the same infrastructure with different behaviour.

Config shape:

```json
{ "classifier": { … },              // shared — one Arch-Router
  "live": { "enabled": true },      // global kill-switch
  "routers": {
    "auto":        { "default_route": "general", "timeout_ms": 8000, "routes": [ … ] },
    "auto-vision": { "default_route": "general", "timeout_ms": 8000, "routes": [ … ] } } }
```

**Back-compatible:** the pre-multi-router shape (top-level
`routes`/`default_route`/`live.model_name`) is normalized to a single-entry map
in memory, so the hook, binder, recalibration, and the webchat readers all read
either shape. An idempotent `migrate-routes-multi.mjs` converts single → multi
when you want to add profiles.

**GUI (webchat "Auto routing" tab):** a **router picker** (dropdown + New +
Delete) selects which profile the Rules / Models / Logs sub-tabs operate on —
hidden until there's more than one. **New** clones the primary profile as a
starting point and auto-registers it as an assignable openai-compatible model;
**Delete** refuses the last router and any router still assigned to an agent.
Realized in `.claude/skills/add-routing` (hook/binder/recalibration) and the
webchat channel (picker + `primaryRouter`/`listRouters`/`addRouter` server
helpers).
