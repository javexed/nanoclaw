# /add-litellm — minimal local model router (design)

Status: **v1 scope — deliberately minimal.** This skill installs exactly one
thing: a **LiteLLM proxy container** exposing one OpenAI-compatible endpoint
over the models served by one or more **local model servers** — Ollama by
default, or any keyless OpenAI-compatible server (vLLM, LM Studio,
llama.cpp server, TGI, …). Nothing else.

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
- **Keyed backends of any kind** (OpenAI, Anthropic, Bedrock, a token-guarded
  vLLM…) — the config is keyless plaintext and the proxy has no request
  auth, so a credential must never enter this tier. Budgets, virtual keys,
  Postgres — all deferred with the cloud tier, which owns proxy auth
  (`master_key`), TLS, and OneCLI-brokered credentials when it lands.
- Managing the model servers themselves (installing them, pulling models).

## Security posture

- **Keyless**: no `master_key`, no request auth. Justified because v1 has no
  paid backends and the router is **never publicly reachable**: the container
  binds to `127.0.0.1:<port>` and the docker bridge IP only. Agent containers
  reach it at `http://host.docker.internal:<port>/v1` (the `--add-host`
  host-gateway alias NanoClaw already passes on Linux).
- **No credentials anywhere** on this path, so the OneCLI single-pane invariant
  is satisfied trivially (the sanctioned local-plaintext `NO_PROXY` case).
  When a dependent tier adds paid backends, *that* tier owns bringing TLS + an
  OneCLI-brokered virtual key.
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
| `resources/install-litellm.sh` | Idempotent installer: preflight the first host (either roster endpoint) → generate config → run container (localhost + bridge bind) → health-check `/v1/models`. Re-run on roster changes. |
| `resources/gen-config.mjs` | Probes each host (`/api/tags` → Ollama, else `/v1/models` → OpenAI-compat; or `--tags-file` fixture, kind detected by shape) → `data/litellm/config.yaml`: `ollama_chat/<tag>` / `openai/<id>` deployments, shared-name load balancing across kinds, `request_timeout: 600`, `num_retries: 2`, `drop_params: true`. Exports `generate()` for dependent skills to compose. |
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
