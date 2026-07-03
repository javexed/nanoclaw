---
name: add-litellm
description: Add a minimal LiteLLM router container exposing one OpenAI-compatible endpoint over the models of one or more Ollama hosts (localhost default). Keyless, local-only. The dependency base for classifier routing and other LLM-fleet skills. Use when the user wants local Ollama models behind a single endpoint for NanoClaw agents.
---

# Add LiteLLM (minimal local model router)

Installs the [LiteLLM](https://docs.litellm.ai) proxy as a local Docker
container: **one OpenAI-compatible endpoint over every model your Ollama
host(s) serve**. Deliberately minimal — no classifier, no routing policy, no
keys. Dependent skills (classifier routing, escalation) layer on top of this.

Design: [docs/design/add-litellm.md](../../../docs/design/add-litellm.md).

## Prerequisites

1. **Docker** and **Node** on the host.
2. **Ollama running** with ≥1 model pulled — localhost default; verify:
   `curl -s http://localhost:11434/api/tags`. LAN hosts optional.

## Install

```bash
bash .claude/skills/add-litellm/resources/install-litellm.sh \
  [--hosts http://localhost:11434,http://<lan-ip>:11434] \
  [--port 4000] [--tag <litellm-image-tag>] [--dry-run]
```

Idempotent — re-run whenever the Ollama roster changes. What it does:

1. **Discovers** models on every `--hosts` entry (`GET /api/tags`).
2. **Generates `data/litellm/config.yaml`** — one `ollama_chat/<tag>`
   deployment per (host, tag); the same tag on several hosts load-balances
   under one name; streaming-safe agentic timeouts.
3. **Runs** `ghcr.io/berriai/litellm:latest` (override with `--tag`) bound to
   `127.0.0.1:<port>` **and** the docker bridge IP — reachable from agent
   containers at `http://host.docker.internal:<port>/v1`, from nowhere else.
   **Keyless — never expose this port publicly.**
4. **Health-checks** `/v1/models`.

## Verify

```bash
curl -s http://127.0.0.1:4000/v1/models | head -c 400
curl -sN http://127.0.0.1:4000/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model": "<a-roster-tag>", "stream": true, "messages": [{"role":"user","content":"say hi"}]}' | head -5
```

## Wire an agent group (config, not code)

Register a webchat model — kind **`openai-compatible`**, `endpoint` =
`http://host.docker.internal:4000/v1`, `model_id` = a tag from the roster —
and assign it to an agent group in the webchat Models UI. Zero core-code
edits; the SSRF policy and host-gateway alias already permit the address.

## Operations

- **Roster changed** → re-run the installer.
- **Admin UI**: `http://127.0.0.1:4000/ui` (localhost only).
- **Logs**: `docker logs nanoclaw-litellm`.
- **Tests**: `node --test .claude/skills/add-litellm/resources/generators.test.mjs`.

## For dependent skills

Import `generate()` from `resources/gen-config.mjs` and post-process, then
re-run the container with extra mounts/env (superseding this one). Keep the
invariants: keyless, local-only binding, `data/litellm/` as the config home.
Restoring the base state is always: re-run this installer.
