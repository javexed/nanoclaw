# /add-litellm — minimal local model router (design)

Status: **v1 scope — deliberately minimal.** This skill installs exactly one
thing: a **LiteLLM proxy container** exposing one OpenAI-compatible endpoint
over the models served by one or more **Ollama** hosts. Nothing else.

It is the **dependency base** for the broader LLM-routing work (classifier
routing, capability score tables, Claude escalation) — those live in their own
skills/branches and build **on top of** this one. Nothing in this skill knows
they exist.

## Goal

One endpoint, many local models:

```
agent container ──► LiteLLM (:4000, keyless, local-only) ──┬─► Ollama (localhost — default)
                                                           └─► Ollama (LAN host 1..n)
```

- **Discoverable**: the installer reads each host's `GET /api/tags` and
  generates the `model_list` — no hand-maintained registry.
- **Load-balancing for free**: the same model tag on two hosts becomes two
  deployments under one `model_name`; LiteLLM balances between them
  (`simple-shuffle`).
- **Agentic-safe**: streaming and tool calls pass through; generous
  `request_timeout` (agentic turns are long).

## Non-goals (owned by dependent skills, not here)

- Classifier / capability routing (`model="auto"`), score tables, route
  bindings, fallback chains between *different* models.
- Cross-plane escalation to Claude.
- Cloud/API-key backends, budgets, virtual keys, Postgres — all deferred with
  the cloud tier.
- Managing Ollama itself (installing it, pulling models).

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
| `resources/install-litellm.sh` | Idempotent installer: preflight Ollama → generate config → run container (localhost + bridge bind) → health-check `/v1/models`. Re-run on roster changes. |
| `resources/gen-config.mjs` | `GET /api/tags` per host (or `--tags-file` fixture) → `data/litellm/config.yaml`: `ollama_chat/<tag>` deployments, shared-name load balancing, `request_timeout: 600`, `num_retries: 2`, `drop_params: true`. Exports `generate()` for dependent skills to compose. |
| `resources/fixtures/ollama-tags.json` | Two-host fixture for offline generation/tests. |
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
