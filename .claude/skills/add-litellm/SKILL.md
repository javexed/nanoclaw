---
name: add-litellm
description: Add a minimal LiteLLM router container exposing one OpenAI-compatible endpoint over local model servers — Ollama (default) or any keyless OpenAI-compatible server (vLLM, LM Studio, llama.cpp, TGI) — plus opt-in keyed cloud backends (OpenAI, Anthropic, …) with proxy auth. Local-only binding. The dependency base for classifier routing and other LLM-fleet skills. Use when the user wants many models behind a single endpoint for NanoClaw agents.
---

# Add LiteLLM (minimal local model router)

Installs the [LiteLLM](https://docs.litellm.ai) proxy as a local Docker
container: **one OpenAI-compatible endpoint over every model your local
server(s) serve**. Ollama is the default backend; any keyless
OpenAI-compatible server (vLLM, LM Studio, llama.cpp server, TGI, …) works
the same way — hosts are probed and their rosters discovered automatically.
Keyed cloud backends are an explicit opt-in (below). Deliberately minimal —
no classifier, no routing policy. Dependent skills (classifier routing,
escalation) layer on top of this.

Design: [docs/webchat/design/add-litellm.md](../../../docs/webchat/design/add-litellm.md).

## Prerequisites

1. **Docker** and **Node** on the host.
2. **A local model server running** with ≥1 model — localhost Ollama default;
   verify: `curl -s http://localhost:11434/api/tags`. For an OpenAI-compatible
   server instead: `curl -s http://<host>:<port>/v1/models`. LAN hosts optional.

## Install

```bash
bash "${CLAUDE_SKILL_DIR}/resources/install-litellm.sh" \
  [--hosts http://localhost:11434,http://<lan-ip>:8000] \
  [--port 4000] [--tag <litellm-image-tag>] [--dry-run]
```

Idempotent — re-run whenever a roster or the backends file changes. What it
does:

1. **Discovers** models on every `--hosts` entry — Ollama hosts via
   `GET /api/tags`, OpenAI-compatible hosts via `GET /v1/models` (probed
   automatically, no per-host configuration).
2. **Generates `data/litellm/config.yaml`** — one deployment per
   (host, model): `ollama_chat/<tag>` for Ollama hosts, `openai/<id>` for
   OpenAI-compatible hosts; the same model name on several hosts
   load-balances under one name (across backend kinds too); streaming-safe
   agentic timeouts.
3. **Runs** `ghcr.io/berriai/litellm` at a pinned version (override with
   `--tag`; the default pin lives in the installer) bound to
   `127.0.0.1:<port>` **and** the docker bridge IP — reachable from agent
   containers at `http://host.docker.internal:<port>/v1`, from nowhere else.
   **Never expose this port publicly.**
4. **Health-checks** `/v1/models` (with auth, in keyed mode).

## Verify

```bash
curl -s http://127.0.0.1:4000/v1/models | head -c 400
curl -sN --max-time 90 http://127.0.0.1:4000/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model": "<a-roster-tag>", "stream": true, "messages": [{"role":"user","content":"say hi"}]}' | head -5
```

The first token can take 10–30s+ while the backend cold-loads the model — a
slow first completion is normal, not a failure. (Ollama: `/api/ps` on the
host shows the model once loaded.)

## Wire an agent group (config, not code)

The router is a standard OpenAI-compatible endpoint —
`http://host.docker.internal:4000/v1` from agent containers — so any
consumer that speaks the protocol can use it. Zero core-code edits either
way; pick whichever your install has:

- **Webchat Models UI** (if the webchat channel is installed): register a
  model — kind **`openai-compatible`**, `endpoint` as above, `model_id` = a
  name from the roster — and assign it to an agent group. The SSRF policy
  and host-gateway alias already permit the address.
- **Default Claude harness** (no extra provider needed): LiteLLM serves the
  Anthropic `/v1/messages` surface, so the Claude Agent SDK can talk to it
  natively. Either assign an `openai-compatible` model to the group in webchat
  (above), or point the agent group's `ANTHROPIC_BASE_URL` at the LiteLLM
  endpoint (`http://host.docker.internal:4000`) with a roster model — the SDK
  routes through it with no provider hop.
- **Any other OpenAI-compatible client**: base URL + a model name from the
  roster.

The wiring is a runtime operator action with no source footprint, so there
is no in-tree integration point for a test to guard
(docs/skill-guidelines.md, "when there is genuinely nothing to test in-tree").
The generator tests below are optional unit coverage of this skill's own
logic, not integration legs.

## Operations

- **Roster or backends changed** → re-run the installer.
  ⚠ Re-running regenerates `config.yaml` and recreates the container, which
  **drops any dependent-skill layering** (e.g. `/add-routing`'s callback hook
  — its virtual `auto` model stops resolving until it's restored). Re-run the
  dependent skill's installer afterwards: add-litellm first, then the layer.
- **Admin UI**: `http://127.0.0.1:4000/ui` (localhost only).
- **Logs**: `docker logs nanoclaw-litellm`.
- **Tests**: `node --test "${CLAUDE_SKILL_DIR}/resources/generators.test.mjs"`.

## Keyed backends (opt-in)

Cloud/keyed models (OpenAI, Anthropic, a token-guarded vLLM, …) can sit
behind the same endpoint. They can't be discovered, so declare them in
`data/litellm/backends.json`:

```json
[
  { "model_name": "gpt-4o", "model": "openai/gpt-4o", "api_key_env": "OPENAI_API_KEY" },
  { "model_name": "claude-sonnet", "model": "anthropic/claude-sonnet-4-6", "api_key_env": "ANTHROPIC_API_KEY" }
]
```

`api_key_env` is an env-var **NAME** — a literal `api_key` field is a hard
error, so a key value can never end up in the (plaintext) generated config.
Put the values in `data/litellm/env` (one `NAME=value` line each; mode 600,
gitignored via `data/`), then re-run the installer. It then automatically:

- generates `data/litellm/master.key` and turns on **proxy auth**
  (`master_key`) — mandatory once a paid key sits behind the endpoint, since
  an open port would be a free credential proxy;
- passes the env file to the container (`--env-file`) and health-checks with
  auth.

Agents authenticate the sanctioned way — register the master key in OneCLI
so the gateway injects it per request (no restarts, no key in agent env):

```bash
onecli secrets create --name "LiteLLM router" --type generic \
  --value "$(cat data/litellm/master.key)" --host-pattern "host.docker.internal" \
  --header-name "Authorization" --value-format "Bearer {value}"
```

Trust boundary, stated honestly: backend key values live on the host disk
(mode 600) and in the LiteLLM container's environment (visible to anyone who
can `docker inspect`) — the same trust domain as the host itself. Binding
stays localhost + bridge; **TLS is owed before this endpoint ever leaves the
machine**. Keyed-only installs (no local servers) are supported:
`--hosts ''`.

## For dependent skills

Import `generate()` from `resources/gen-config.mjs` and post-process, then
re-run the container with extra mounts/env (superseding this one). Keep the
invariants: local-only binding, key values only ever in `data/litellm/env`
(never in generated config), proxy auth on whenever a keyed backend exists,
and `data/litellm/` as the config home. Restoring the base state is always:
re-run this installer.
