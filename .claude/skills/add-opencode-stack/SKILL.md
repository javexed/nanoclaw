---
name: add-opencode-stack
description: One-command stack for running agents on models beyond the built-in Claude path — installs the OpenCode agent provider and the LiteLLM router, then wires an agent group to a routed model through the OpenCode provider. Backends can be local (Ollama, vLLM, LM Studio, …) or opt-in keyed cloud. Use when the user wants agents running on their own model servers end to end.
---

# Add the OpenCode stack (OpenCode → LiteLLM → your model servers)

Batteries-included composition of two existing skills, in dependency order,
plus a wiring step:

1. **OpenCode provider** (`/add-opencode`) — the harness that lets an agent
   group run against any OpenAI-compatible endpoint instead of the Claude SDK.
2. **LiteLLM router** (`/add-litellm`) — one local-only endpoint over every
   model your server(s) serve; Ollama by default, any keyless
   OpenAI-compatible server likewise, keyed cloud backends as an explicit
   opt-in.
3. **Wire a group onto the router** — point an agent group's OpenCode config
   at the router endpoint with a roster model, and set the group's provider
   to `opencode`. If no agent group exists yet, this stage first runs
   `/init-first-agent` (which needs a configured channel) to create one.

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

## Install

### 1. OpenCode provider

Skip if `src/providers/opencode.ts` and
`container/agent-runner/src/providers/opencode.ts` both exist. Otherwise run
the **`/add-opencode`** skill (`.claude/skills/add-opencode/SKILL.md`) —
follow its Install section end to end: copy from the `providers` branch, wire
both barrels, pin `@opencode-ai/sdk` and the `opencode-ai` CLI (versions must
match; see that skill's warnings), copy its tests, build, and **rebuild the
agent image**. All its validation gates must be green before continuing.

> ⚠ **Rebuild every PER-GROUP image too, or those groups crash-loop at
> boot — Claude-only groups included.** The barrel edit adds a top-level
> `import './opencode.js'` that EVERY container evaluates at startup (the
> runner source is bind-mounted into all of them), and it resolves
> `@opencode-ai/sdk` against the *image's* `node_modules`. Groups that ever
> used self-mod `install_packages` have their own image tag layered on the
> old base — new code + stale dependencies = `Cannot find module
> '@opencode-ai/sdk'` before the group's provider setting is even read, and
> host-sweep re-wakes them into the same crash forever. Find and fix them:
>
> ```bash
> pnpm exec tsx scripts/q.ts data/v2.db \
>   "SELECT agent_group_id FROM container_configs WHERE image_tag IS NOT NULL"
> ncl groups restart --rebuild --id <each-group-id>
> ```
>
> Symptom in `logs/nanoclaw.error.log`: repeated `Container exited non-zero`
> with that stderr, once per sweep. Same rule applies to ANY future dep added
> to the shared runner: code updates by mount, dependencies update by image.

### 2. LiteLLM router

Skip if `curl -s http://127.0.0.1:4000/v1/models` already answers with your
models. Otherwise run the **`/add-litellm`** installer with every model-server
host you want routed:

```bash
bash .claude/skills/add-litellm/resources/install-litellm.sh \
  --hosts http://<host-1>:11434,http://<host-2>:11434
```

Re-run it whenever a roster or the backends file changes (idempotent).

### 3. Wire an agent group onto a routed model

The router is a standard OpenAI-compatible endpoint —
`http://host.docker.internal:4000/v1` from agent containers. Wire a group to
it through the OpenCode provider (config, not code):

1. **Ensure a target agent group exists** — this stage wires an *existing*
   group, so one must be present. Check: `ncl groups list`. If it returns
   none, run **`/init-first-agent`** first to stand up the first DM-wired
   group, then continue here. That skill has its own prerequisite — a
   configured channel — so if no `/add-<channel>` has been run yet, install
   one first (`/add-telegram`, `/add-slack`, `/add-discord`, …). Skip this
   step when a group already exists; it is idempotent, so never create a
   duplicate.
2. **Pick a model** from the roster:
   `curl -s http://127.0.0.1:4000/v1/models`.
3. **Point OpenCode at the router** and select that model — see
   `/add-opencode`'s **Configuration** (the `OPENCODE_*` variables) and
   `/add-litellm`'s **"Wire an agent group"** for the exact shape. In short:
   set the OpenCode base URL to the router endpoint above and the OpenCode
   model to a roster tag.
4. **Switch the group's provider to OpenCode** so it uses that harness:
   ```bash
   ncl groups config update --id <agent-group-id> --provider opencode
   ncl groups restart --id <agent-group-id> --message "switched to OpenCode via LiteLLM"
   ```
   Revert any time with `--provider claude`.

The wiring is a runtime operator action with no source footprint, so there is
no in-tree integration point for a test to guard (docs/skill-guidelines.md,
"when there is genuinely nothing to test in-tree").

> **If the webchat channel is installed**, you can register the roster in its
> **Models** UI instead and assign a model to a group with point-and-click —
> assigning flips that group onto OpenCode automatically, unassigning reverts.
> This skill does **not** require webchat; the steps above are the portable
> path.

### 4. Verify

```bash
# Router serves models
curl -s http://127.0.0.1:4000/v1/models | head -c 300
# OpenCode registered in BOTH trees (guards from /add-opencode)
pnpm exec vitest run src/providers/opencode-registration.test.ts
cd container/agent-runner && bun test src/providers/opencode-registration.test.ts && cd -
```

Then the end-to-end leg: with a group wired to OpenCode (stage 3) and a roster
model selected, send it a message. The first reply can take 10-30s+ while the
backend cold-loads the model. Set the group's provider back to `claude` to
return it to the built-in path.

## Operations

- **Roster changed** → re-run stage 2 (idempotent); new models become
  selectable immediately.
- **Keyed cloud backends** → configure per `/add-litellm` ("Keyed backends").
- **Which agent runs on what** → the group's provider (`ncl groups config`)
  plus its OpenCode model — or the webchat Models UI, if that channel is
  installed.

## Removal

See [REMOVE.md](REMOVE.md).
