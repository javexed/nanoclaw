---
name: add-opencode-stack
description: One-command stack for running agents on models beyond the built-in Claude path — installs the OpenCode agent provider, the LiteLLM router, and registers the router's models in webchat so assigning one flips an agent onto OpenCode. Backends can be local (Ollama, vLLM, LM Studio, …) or opt-in keyed cloud. Use when the user wants agents running on their own model servers end to end.
---

# Add the OpenCode stack (OpenCode → LiteLLM → your model servers)

Batteries-included composition of three existing pieces, in dependency order:

1. **OpenCode provider** (`/add-opencode`) — the harness that lets an agent
   group run against any OpenAI-compatible endpoint instead of the Claude SDK.
2. **LiteLLM router** (`/add-litellm`) — one local-only endpoint over every
   model your server(s) serve; Ollama by default, any keyless
   OpenAI-compatible server likewise, keyed cloud backends as an explicit
   opt-in.
3. **Webchat model registration** (this skill's `resources/register-models.mjs`)
   — every routed model becomes an assignable webchat model. Assigning one to
   an agent switches that agent's provider to OpenCode automatically
   (`syncAgentProviderForAssignedModel`); unassigning reverts to Claude.

Each piece stays independently useful — this skill only sequences them and is
idempotent: every stage no-ops when its work is already in place, so re-run it
freely (e.g. after adding models to a backend).

**This is not "local-only":** LiteLLM's keyed-backend opt-in can route to
cloud providers (OpenAI, Anthropic, …) behind the same endpoint. See the
`/add-litellm` skill for that configuration and its trust boundary.

## Prerequisites

1. **Docker** and **Node** on the host.
2. **At least one model server** with ≥1 model, reachable from this host:
   - Ollama (default): `curl -s http://<host>:11434/api/tags`
   - any OpenAI-compatible server: `curl -s http://<host>:<port>/v1/models`
   No server yet? Install Ollama first (https://ollama.com/download) or
   declare keyed cloud backends per `/add-litellm` — a keyed-only stack is
   supported (`--hosts ''`).
3. **Webchat channel installed** (the Models UI is where routed models get
   assigned). Without webchat, stop after stage 2 and wire groups by hand per
   `/add-litellm`'s "For dependent skills".

## Install

### 1. OpenCode provider

Skip if `src/providers/opencode.ts` and
`container/agent-runner/src/providers/opencode.ts` both exist. Otherwise run
the **`/add-opencode`** skill (`.claude/skills/add-opencode/SKILL.md`) —
follow its Install section end to end: copy from the `providers` branch, wire
both barrels, pin `@opencode-ai/sdk` and the `opencode-ai` CLI (versions must
match; see that skill's warnings), copy its tests, build, and **rebuild the
agent image**. All its validation gates must be green before continuing.

The `OPENCODE_*` host env configuration in that skill is **not needed** for
this stack — per-agent model env comes from the webchat model assignment
(settings.json), not install-wide variables.

### 2. LiteLLM router

Skip if `curl -s http://127.0.0.1:4000/v1/models` already answers with your
models. Otherwise run the **`/add-litellm`** installer with every model-server
host you want routed:

```bash
bash .claude/skills/add-litellm/resources/install-litellm.sh \
  --hosts http://<host-1>:11434,http://<host-2>:11434
```

Re-run it whenever a roster or the backends file changes (idempotent).

### 3. Register the routed models in webchat

```bash
node .claude/skills/add-opencode-stack/resources/register-models.mjs \
  --checkout . [--port 4000] [--dry-run]
```

Reads the live roster from the router and upserts one webchat model per entry
— kind `openai-compatible`, endpoint `http://host.docker.internal:<port>/v1`
(the container-facing form; the host side translates for its own fetches).
Dedupe is by display name, so models registered by hand earlier are left
untouched and re-runs only add roster newcomers. `--dry-run` previews.

### 4. Verify

```bash
# Router serves models
curl -s http://127.0.0.1:4000/v1/models | head -c 300
# OpenCode registered in BOTH trees (guards from /add-opencode)
pnpm exec vitest run src/providers/opencode-registration.test.ts
cd container/agent-runner && bun test src/providers/opencode-registration.test.ts && cd -
# Registration script behaves
node --test .claude/skills/add-opencode-stack/resources/register-models.test.mjs
```

Then the end-to-end leg: in the webchat **Models** UI, assign one of the
registered models to a (test) agent — the assignment flips that group's
provider to OpenCode and restarts its container — and send it a message. The
first reply can take 10-30s+ while the backend cold-loads the model. Unassign
to return the agent to Claude.

## Operations

- **Roster changed** → re-run stages 2 and 3 (both idempotent).
- **Keyed cloud backends** → configure per `/add-litellm` ("Keyed backends"),
  then re-run stage 3 to register the new names.
- **Which agent runs on what** → the webchat Models UI is the single control
  surface; no `.env` or `container.json` edits.

## Removal

See [REMOVE.md](REMOVE.md).
