---
name: add-litellm
description: Add a minimal LiteLLM router container exposing one OpenAI-compatible endpoint over the models of one or more local model servers — Ollama (default) or any keyless OpenAI-compatible server (vLLM, LM Studio, llama.cpp, TGI). Keyless, local-only. The dependency base for classifier routing and other LLM-fleet skills. Use when the user wants local models behind a single endpoint for NanoClaw agents.
---

# Add LiteLLM (minimal local model router)

Installs the [LiteLLM](https://docs.litellm.ai) proxy as a local Docker
container: **one OpenAI-compatible endpoint over every model your local
server(s) serve**. Ollama is the default backend; any keyless
OpenAI-compatible server (vLLM, LM Studio, llama.cpp server, TGI, …) works
the same way — hosts are probed and their rosters discovered automatically.
Deliberately minimal — no classifier, no routing policy, no keys. Dependent
skills (classifier routing, escalation) layer on top of this.

Design: [docs/design/add-litellm.md](../../../docs/design/add-litellm.md).

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

Idempotent — re-run whenever a roster changes. What it does:

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
   **Keyless — never expose this port publicly.**
4. **Health-checks** `/v1/models`.

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

Register a webchat model — kind **`openai-compatible`**, `endpoint` =
`http://host.docker.internal:4000/v1`, `model_id` = a name from the roster —
and assign it to an agent group in the webchat Models UI. Zero core-code
edits; the SSRF policy and host-gateway alias already permit the address.

This registration is a runtime operator action with no source footprint, so
there is no in-tree integration point for a test to guard
(docs/skill-guidelines.md, "when there is genuinely nothing to test in-tree").
The generator tests below are optional unit coverage of this skill's own
logic, not integration legs.

## Operations

- **Roster changed** → re-run the installer.
- **Admin UI**: `http://127.0.0.1:4000/ui` (localhost only).
- **Logs**: `docker logs nanoclaw-litellm`.
- **Tests**: `node --test "${CLAUDE_SKILL_DIR}/resources/generators.test.mjs"`.

## Scope: local and keyless only

Backends that need an API key (OpenAI, Anthropic, Bedrock, …) are **out of
scope** for this skill and must not be added to the generated config — the
router is keyless and its config is plaintext on disk. The deferred cloud
tier (docs/design/add-litellm.md, non-goals) owns keyed backends, bringing
proxy auth (`master_key`), TLS, and OneCLI-brokered credentials with it.

## For dependent skills

Import `generate()` from `resources/gen-config.mjs` and post-process, then
re-run the container with extra mounts/env (superseding this one). Keep the
invariants: keyless, local-only binding, `data/litellm/` as the config home.
Restoring the base state is always: re-run this installer.
