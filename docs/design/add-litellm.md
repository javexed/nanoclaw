# /add-litellm — minimal local model router (design)

Status: **v1 scope — deliberately minimal.** This skill installs exactly one
thing: a **LiteLLM proxy container** exposing one OpenAI-compatible endpoint
over the models served by one or more **local model servers** — Ollama by
default, or any keyless OpenAI-compatible server (vLLM, LM Studio,
llama.cpp server, TGI, …) — plus, **opt-in**, declared keyed cloud backends
(with proxy auth mandatory the moment one exists). Nothing else.

It is the **dependency base** for the broader LLM-routing work (classifier
routing, capability score tables, Claude escalation) — those live in their own
skills/branches and build **on top of** this one. Nothing in this skill knows
they exist.

## Goal

One endpoint, many local models:

```
agent container ──► LiteLLM (:4000, keyless, local-only) ──┬─► Ollama (localhost — default)
                                                           ├─► Ollama (LAN host …)
                                                           └─► any keyless OpenAI-compat
                                                               server (vLLM, LM Studio,
                                                               llama.cpp, TGI — LAN host …)
```

- **Discoverable**: the installer probes each host — Ollama answers
  `GET /api/tags` (deployments use the `ollama_chat/` prefix for its richer
  chat/tool handling); anything else is expected to answer the standard
  `GET /v1/models` (deployments use `openai/<id>` + `api_base`, with a
  placeholder `api_key` since the server is keyless) — and generates the
  `model_list`. No hand-maintained registry, no per-host kind configuration.
- **Load-balancing for free**: the same model name on two hosts becomes two
  deployments under one `model_name`; LiteLLM balances between them
  (`simple-shuffle`). This works across backend kinds — an Ollama host and a
  vLLM host serving the same model share one name.
- **Agentic-safe**: streaming and tool calls pass through; generous
  `request_timeout` (agentic turns are long).

## Non-goals (owned by dependent skills, not here)

- Classifier / capability routing (`model="auto"`), score tables, route
  bindings, fallback chains between *different* models.
- Cross-plane escalation to Claude.
- Budgets, per-key virtual keys, spend tracking, Postgres (`DATABASE_URL`) —
  the fleet-management tier owns those. This skill stops at one master key.
- TLS — owed the moment the endpoint would leave localhost/bridge; until
  then binding is the perimeter.
- Managing the model servers themselves (installing them, pulling models).

## Security posture

- **Keyless by default**: no `master_key`, no request auth, as long as only
  discovered local backends exist. Justified because the router is **never
  publicly reachable**: the container binds to `127.0.0.1:<port>` and the
  docker bridge IP only. Agent containers reach it at
  `http://host.docker.internal:<port>/v1` (the `--add-host` host-gateway
  alias NanoClaw already passes on Linux).
- **Keyed mode auto-arms proxy auth** (llm-router.md §9b pulled forward):
  declaring any backend in `backends.json` makes the generator emit
  `general_settings.master_key` and the installer generate
  `data/litellm/master.key` (mode 600) — an unauthenticated endpoint fronting
  a paid key would be a free credential proxy. Backend key VALUES never enter
  the generated config: entries name an env var (`api_key_env`, literal keys
  are a generator hard error), values live in `data/litellm/env` (mode 600)
  read via `--env-file`. Trust boundary stated honestly: those values are in
  the LiteLLM container's environment (`docker inspect`-visible) — same trust
  domain as the host.
- **Agent → router credential goes through OneCLI** (single-pane invariant):
  the master key is registered as a OneCLI secret with host-pattern
  `host.docker.internal`, injected per request by the gateway. The keyless
  local path stays the sanctioned local-plaintext `NO_PROXY` case. TLS is
  owed before the endpoint ever leaves the machine (`webchat_models.
  credential_ref` is reserved but unimplemented, so OneCLI injection is the
  only wired path today).
- **Image**: `ghcr.io/berriai/litellm` pinned to an exact version in the
  installer (docs/skill-guidelines.md: pin the version; reject `latest`);
  `--tag` / `LITELLM_TAG` to override. The image is outside the pnpm
  supply-chain gate, so the pin is the only version control it gets. Note
  LiteLLM stopped publishing `main-stable` tags on 2026-06-30 — `latest` is
  their rolling-stable pointer now; we still pin.

## NanoClaw integration: config, not code

Zero core-code edits. NanoClaw consumes the router through the **existing**
webchat model kind **`openai-compatible`** (`endpoint` =
`http://host.docker.internal:<port>/v1`, `model_id` = any tag from the
`model_list`), assigned per agent group like any other model. The SSRF policy
already allows the address; the host-gateway alias is already wired.

Because there are no core edits, there are no vitest integration legs
(docs/skill-guidelines.md) — the skill's own generators are covered by
fixture-driven `node --test` tests, runnable with no Ollama present.

## Files & flow

| File | Role |
|------|------|
| `resources/install-litellm.sh` | Idempotent installer: preflight the first host (either roster endpoint) → keyed mode: master.key + env-file validation → generate config → run container (localhost + bridge bind, `--env-file` when keyed) → health-check `/v1/models` (authed when keyed). Re-run on roster/backends changes. |
| `resources/gen-config.mjs` | Probes each host (`/api/tags` → Ollama, else `/v1/models` → OpenAI-compat; or `--tags-file` fixture, kind detected by shape) + merges declared keyed backends (`--backends`, `os.environ/` refs only, `master_key` auto-on) → `data/litellm/config.yaml`: `ollama_chat/<tag>` / `openai/<id>` deployments, shared-name load balancing across kinds, `request_timeout: 600`, `num_retries: 2`, `drop_params: true`. Exports `generate()` for dependent skills to compose. |
| `resources/fixtures/rosters.json` | Three-host fixture (two Ollama, one OpenAI-compat) for offline generation/tests. |
| `resources/generators.test.mjs` | `node --test` coverage of the generator. |

Runtime artifacts land in `data/litellm/` (gitignored with the data dir);
removal (`REMOVE.md`) is container + `data/litellm/` + optional webchat model
deregistration — nothing else to reverse.

## Extension seam for dependent skills

Dependent skills (e.g. a classifier layer) may:

1. import `generate()` from this skill's `gen-config.mjs` and post-process the
   YAML (append callbacks / router fallbacks), and
2. re-run the container with additional mounts/env, superseding this skill's
   plain container.

They must keep this skill's invariants: keyless, local-only binding, and
`data/litellm/` as the config home. Restoring the base state is always
"re-run this skill's installer".
