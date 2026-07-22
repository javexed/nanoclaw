# Auto routing — prompt-aware model routing (as built)

**Status:** shipped. Shadow logging + flag-gated live routing + multiple named
routing profiles are all live. This is the *implementation* reference; the
design rationale and the wider provider vision live in
[llm-router.md](llm-router.md) (esp. §16). Installed by the `/add-litellm` +
`/add-routing` skills (or the webchat **"Set up routing"** button).

Auto routing sends each turn to the *right* local model by **classifying the
prompt** against operator-defined capability routes, then rewriting the request
to the model bound to the winning route — all inside the LiteLLM proxy, before a
deployment is chosen. An agent opts in by being assigned the virtual model
`auto` (or another profile name); everything else is unchanged.

## 1. The pieces

| Piece | What it is | Where |
|---|---|---|
| **LiteLLM proxy** | OpenAI-compatible router on `:4000`; every routed turn goes through it | external container; `data/litellm/config.yaml` |
| **Arch-Router (~1.5B)** | the route classifier, self-hosted on a LAN Ollama | `classifier.url` in `routes.json` |
| **The hook** | LiteLLM pre-call callback that classifies + rewrites the model | `router_hook.py` → mounted at the import root `/app/router_hook.py` (config + log live under `/app/routing/`); `config.yaml: callbacks: router_hook.proxy_handler_instance` |
| **`routes.json`** | the route catalog + classifier endpoint + live flag + router profiles | `data/litellm/routing/routes.json` (operator-owned) |
| **Decision log** | one JSONL line per classification (shadow and live) | `data/litellm/routing/routing-shadow.jsonl` |
| **The binder** | scores the roster and (re)binds routes → models | `bind-routes.mjs` + `capabilities.json` |
| **Recalibration** | nightly report + per-router timeout tuning + log rotation | `recalibrate.mjs` |
| **The console** | the webchat **Auto routing** tab + `/api/router/*` | `src/channels/webchat/{server.ts,ollama-manage.ts}`, `public/webchat/app.js` |

The virtual model `auto` is **not** in LiteLLM's `model_list` — it exists only
because the hook rewrites it per-prompt. A request naming a concrete roster
model is never touched.

## 2. Runtime flow (the request path)

```
agent (model="auto", ANTHROPIC_BASE_URL host.docker.internal:4000)
      │  the Claude harness issues a request to LiteLLM's Anthropic /v1/messages
      ▼
LiteLLM :4000 ── async_pre_call_hook(data)  [router_hook.py: class ShadowRouter]
      │
      ├─ text = last user message (system-wrapper stripped)      _last_user_text
      ├─ cfg  = routes.json                                       _load_routes
      │
      ├─ LIVE  (cfg.live.enabled AND data.model ∈ cfg.routers):
      │     route  = classify(prompt) against THIS router's routes   _classify
      │     ├─ escalate route  → raise 400 no_adequate_model  (→ fallback_provider)
      │     └─ else            → data["model"] = binding(route) or default_binding
      │                                                          _route_live
      │
      └─ SHADOW (otherwise): create_task(classify + log); request proceeds UNTOUCHED
                                                                  _classify_and_log
      ▼
LiteLLM picks the deployment for the (possibly rewritten) model → generates
```

- **Shadow** is always on: every request is classified on a background task and
  logged; it never blocks and never modifies the request. This is how you
  calibrate before going live.
- **Live** holds the request for one classify (its own tighter `timeout_ms`),
  then rewrites `data["model"]`. **Failure posture:** any classifier problem
  (host asleep, timeout, bad JSON, unknown route, route `other`) falls back to
  the router's `default_route` binding — a routed request never fails *because
  of routing*. The one exception is an affirmative `escalate` match (§5).

## 3. `routes.json` — config shape

```json
{
  "classifier": { "url": "http://HOST:11434/api/chat", "model": "…Arch-Router…",
                  "timeout_ms": 15000, "keep_alive": "60m" },   // shared
  "live": { "enabled": true },                                  // global kill-switch
  "routers": {                                                  // one or more profiles
    "auto":        { "default_route": "general", "timeout_ms": 8000, "routes": [ … ] },
    "auto-vision": { "default_route": "general", "timeout_ms": 8000, "routes": [ … ] }
  }
}
```

Each **route** is `{ name, description, model }`, or `{ name, description,
escalate: true }` (no local binding — §5), or `{ …, pinned: true }` (the binder
never touches it). The **`description` is the whole game** — it's the only thing
the classifier matches against.

**A fresh install is single-router** — the seed (`routes.example.json`) is the
top-level shape (`classifier`/`default_route`/`live.model_name`/`routes`); the
`routers` map above is what you get once you add a second profile. Both shapes
are read everywhere: the pre-multi-router shape is normalized to a single-entry
map in memory by `_routers()` (Python hook) / `routers()` (binder + recalibrate
mjs) / `listRouters()`+`primaryRouter()` (host TS) — **KEEP-IN-SYNC** across
those. `migrate-routes-multi.mjs` converts single → multi on disk when you want
to add profiles (or the console's picker does it for you).

## 4. The classifier

Arch-Router maps a prompt to one route name. The hook builds a prompt from the
route `{name, description}` list + the conversation and demands
`{"route": "<name>"}` back (`TASK_INSTRUCTION` + `FORMAT_PROMPT` in
`router_hook.py`). Notes:

- **System-wrapper strip** — the agent-runner prepends `<system>…</system>`
  inside the *user* message; the hook strips it so classification runs on the
  user's actual words, not the preamble (`_strip_system_wrapper`).
- **`keep_alive`** pins the ~1 GB classifier in GPU memory (a cold load adds
  seconds per classify).
- The **exact same prompt contract** is duplicated in the host for the tab's
  test bench (`CLASSIFY_TASK`/`CLASSIFY_FORMAT` in `ollama-manage.ts`,
  `dryClassify`) — **KEEP-IN-SYNC** with `router_hook.py`.

## 5. Multiple routers — routing profiles

Several named routers can coexist in `routers`, all sharing the one classifier
and the one roster; they differ only in routes and bindings. An agent selects a
profile by **which virtual model it's assigned** (`auto`, `auto-vision`,
`auto-cheap`, …). The hook keys `data["model"]` against the map and classifies
against *that* router's routes; escalation, the decision log (`router` field),
the binder, and recalibration are all per-router. Full design: llm-router §16g.

## 6. Escalation — the confidence floor as a route

A route with `"escalate": true` has no local binding. A live match raises a
`400` with a greppable `no_adequate_model:` marker *before any generation*;
NanoClaw's per-agent-group **`fallback_provider`** re-runs the turn on a stronger
provider (Claude). Only an *affirmative* classification escalates — classifier
errors fall back to the local default, never to the (quota-costing) fallback.
Mechanics + rationale: [llm-router.md](llm-router.md) §16c.

## 7. Capability binding (`bind-routes.mjs`)

Auto-binds unpinned, non-escalate routes to the best roster model:

```
score(model, route) = catalog quality[route] − size_penalty
size_penalty        = max(0, paramB − max_comfortable_b) × size_penalty_per_b
```

The size penalty encodes "a good 9B beats an oversized 30B on modest hardware"
without hardcoding hosts (`paramB` parsed from the model id). The catalog is
`capabilities.json`, merged over the operator's optional
`capabilities.local.json`. Runs per-router over the shared roster; dry-run by
default, `--apply` writes `routes.json` atomically. Wired into the nightly timer
and the console's **Refresh roster** chain, so a newly pulled model joins routing
on its own. Operators pin a route (`"pinned": true`) to freeze its binding.

## 8. Recalibration + the decision log

`recalibrate.mjs` (nightly, zero-dep, idempotent):
- always writes a dated markdown report next to the log;
- `--apply` tunes each router's `timeout_ms` from *its own* observed p95 classify
  latency (×1.5, clamped, deadbanded);
- `--rotate` archives log lines older than `--keep-days`.

Each `routing-shadow.jsonl` line: `{ ts, mode: shadow|live, router,
requested_model, prompt_head, route, ms, bound_model|final_model, error? }`.
Sentinels: `route:"__error__"` (classify failed), `*_model:"__escalate__"`
(escalated). The console's metrics + the report both read this file; a logging
failure is swallowed and never surfaces to the request.

## 9. The webchat console

The **Auto routing** tab (owner-only), three sub-tabs — **Rules** (routes editor
+ live classify bench + per-route suggestions), **Models** (the roster with ±
select toggles), **Logs** (recent decisions, filtered to the selected router) —
plus a **router picker** (New / Delete) when there's more than one profile.

`/api/router/*` (all owner-gated; mutations need `X-Webchat-CSRF: 1`):

| Endpoint | Purpose |
|---|---|
| `GET /routes?router=` | selected router's routes + the routers list + live flag |
| `PUT /routes?router=` | write a router's routes/default (`mergeRoutesUpdate`) |
| `POST /routers` `{name}` | create a profile (clones the primary) + register its model |
| `DELETE /routers/:name` | delete a profile (refuses the last, or one with assigned agents) |
| `POST /classify` | run the real classifier on a prompt, change nothing (`dryClassify`) |
| `GET /decisions` | recent decision-log lines |
| `GET /metrics` | shadow-vs-live counts + latency (`getRouterMetrics`) |
| `GET /suggestions` | roster models with a capability no route covers |
| `GET /models` | the LiteLLM roster (`getRouterInfo`) |
| `GET|POST /roster-refresh` | re-run the binder against the current roster |
| `GET|POST /install` | one-click "Set up routing" (pulls classifier, runs installer) |

The single-router GUI operates on the **primary** router (`auto`, else first) via
`primaryRouter()`/`primaryRouterName()`, so the tab works against either config
shape; `listRouters`/`routerView`/`addRouter`/`deleteRouter` back the picker.

## 10. Install

- **`/add-litellm`** stands up the LiteLLM proxy container on `:4000`.
- **`/add-routing`** copies the skill resources, seeds `routes.json` from
  `routes.example.json` **once** (`install-routing.sh` never overwrites an
  existing config), wires the hook into `config.yaml`, and installs the nightly
  recalibration timer (`install-recalibration.sh`).
- The console's **"Set up routing"** button drives the same install over
  `POST /api/router/install` with a progress bar — no shell.

Starts in **shadow mode** (`live.enabled: false`); the operator flips it live
from the tab after reviewing the log.

## 11. Failure posture / edge cases

- **Classifier asleep / timeout / bad JSON / unknown route / `other`** → live
  falls back to the router's `default_route` binding; shadow just logs an error.
- **`live.enabled: false`** → pure shadow; nothing is ever rewritten.
- **Concrete roster model requested** (not a router name) → never rewritten,
  live flag or not.
- **`routes.json` missing / LiteLLM down** → the console degrades to "not
  installed"; agents on `auto` get whatever LiteLLM does with an unknown model
  (so don't assign `auto` before routing is installed + live).
- **Logging failure** → swallowed; a routed request never fails because the log
  couldn't be written.

## 12. Files map

| Area | Files |
|---|---|
| Skill (`.claude/skills/add-routing/resources/`) | `router_hook.py`, `bind-routes.mjs`, `recalibrate.mjs`, `migrate-routes-multi.mjs`, `capabilities.json`, `install-routing.sh`, `install-recalibration.sh`, `routes.example.json`, `test_router_hook.py` |
| Host — routing logic | `src/channels/webchat/ollama-manage.ts` (`readRoutesConfig`, `primaryRouter`, `listRouters`, `addRouter`, `deleteRouter`, `mergeRoutesUpdate`, `dryClassify`, `getRouterInfo`, `getRouterMetrics`, `getRouteSuggestions`, `computeRouteSuggestions`) |
| Host — HTTP + UI | `src/channels/webchat/server.ts` (`/api/router/*`), `public/webchat/{index.html,app.js,style.css}` (the Auto routing tab + picker) |
| Runtime data (operator-owned) | `data/litellm/routing/routes.json`, `…/routing-shadow.jsonl`, `data/litellm/config.yaml` |
| Escalation seam | agent-runner `fallback_provider` (skill-delivered core-escalation payload; llm-router §16c) |

## See also
- [llm-router.md](llm-router.md) — design rationale, the two credential planes,
  escalation (§16c), self-improvement (§16e), multi-router (§16g).
- [add-litellm.md](add-litellm.md) — the proxy install.
- `.claude/skills/add-routing/SKILL.md` — the operator-facing install + tuning
  guide (canonical on the `skill/add-routing` branch).
