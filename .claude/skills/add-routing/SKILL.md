---
name: add-routing
description: Layer an N-way capability classifier (Arch-Router 1.5B on your own Ollama) onto the LiteLLM router — shadow mode first, then flag-gated live routing via a virtual 'auto' model. Every request through the router gets classified against operator-defined capability routes (code / reasoning / general / …) and logged; only requests explicitly naming 'auto' are ever rewritten. The base for the confidence floor and Claude escalation (llm-router design §16). Use when the user wants prompt-aware model routing or to start collecting routing data.
---

# Add routing (capability classifier over LiteLLM, shadow-first)

Implements the classifier tier of
[docs/design/llm-router.md](../../../docs/design/llm-router.md) §16b: an
**Arch-Router 1.5B** route-classifier running on your own model server maps
each prompt to an operator-defined **capability route** (name + English
description), each route **bound to a roster model**. This skill installs it
in **shadow mode**: every completion through LiteLLM is classified and logged,
**nothing about the request changes** — zero risk, and the log calibrates the
later live phases (virtual `auto` model, confidence floor, Claude escalation).

Depends on **`/add-litellm`** (the router must be installed). Layered exactly
per its "For dependent skills" contract: this installer re-runs the container
with extra mounts, superseding the base run.

## Prerequisites

1. `/add-litellm` installed and healthy (`curl -s http://127.0.0.1:4000/v1/models`).
2. **Arch-Router on an Ollama you control** (a ~1GB GGUF; fits beside any
   existing model):

   ```bash
   curl -s -X POST http://<classifier-host>:11434/api/pull \
     -d '{"model":"hf.co/katanemo/Arch-Router-1.5B.gguf:Q4_K_M","stream":false}'
   ```

## Install

```bash
bash "/home/nanoclaw/nanoclaw-v2/.claude/skills/add-routing/resources/install-routing.sh" \
  [--port 4000] [--name nanoclaw-litellm] [--image <litellm-image>]
```

Idempotent. It seeds `data/litellm/routing/routes.json` **once** (then never
overwrites — it's operator-owned), refreshes the skill-owned
`data/litellm/router_hook.py`, wires the callback into `config.yaml`, and
recreates the LiteLLM container with the routing mounts. **After seeding, edit
`routes.json`**: set the classifier host and bind each route to a roster model,
then re-run the installer.

> Ordering note: re-running the `/add-litellm` installer regenerates
> `config.yaml` and recreates the container **without** the hook — re-run this
> installer afterwards to restore it. (Roster changed? add-litellm first, then
> this.)

## Tuning — the whole game is route descriptions

The classifier matches the user's latest intent against each route's English
`description`. Improve routing by editing descriptions, not code — e.g. if
debugging prompts land on `reasoning`, sharpen `code`'s description ("…
including diagnosing errors, stack traces, and unexpected behavior") or split
a dedicated `debugging` route. Finer-grained routes classify better than broad
ones. Prompts matching nothing return route `other` → logged with the
`default_route` binding.

## Verify

```bash
# hook unit tests (inside the LiteLLM image — the host doesn't carry litellm/httpx)
docker run --rm -v "$(pwd)/.claude/skills/add-routing/resources:/t:ro" \
  --entrypoint python ghcr.io/berriai/litellm:v1.90.0 \
  -m unittest discover -s /t -p 'test_*.py'

# end to end: one request through the router, then the decision it logged
curl -s http://127.0.0.1:4000/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"<a-roster-model>","messages":[{"role":"user","content":"write a bash one-liner"}],"max_tokens":10}' >/dev/null
sleep 3; tail -1 data/litellm/routing/routing-shadow.jsonl
```

A healthy line: `{"ts":…, "requested_model":…, "route":"code", "bound_model":…, "ms":~750}`.
`"route":"__error__"` lines mean the classifier was unreachable (host asleep,
timeout) — by design the request itself was unaffected.

## Shadow-log review (what to look at before going live)

- **Agreement**: does `bound_model` usually match what you'd have picked?
- **`other` rate**: high → your routes don't cover real traffic; add/reword.
- **`__error__` rate**: high → classifier host availability; move it or accept
  the default-route fallback for the live phase.
- Warm classify latency (`ms`) sets the live-phase timeout budget.

## Going live — the virtual `auto` model (Phase 2)

When the shadow log looks right, enable live routing in `routes.json`:

```json
"live": { "enabled": true, "model_name": "auto", "timeout_ms": 5000 }
```

No installer re-run needed — the hook re-reads `routes.json` per request.
Semantics:

- A request whose model is exactly `live.model_name` (`auto`) is classified
  **synchronously** (adds one warm classify, ~750–1000ms) and rewritten to the
  matched route's bound model before LiteLLM picks a deployment.
- **Fallback, never failure**: classifier unreachable / timeout / bad JSON /
  route `other` or unknown → the request runs on the `default_route` binding.
  `live.timeout_ms` (default 5000) bounds how long a request can wait on the
  classifier — keep it tight; the fallback is always available.
- Requests naming a **concrete roster model are never rewritten**, flag or no
  flag. Shadow logging continues for them unchanged.
- Every live decision is logged to the same JSONL with `"mode":"live"` and a
  `final_model` field — `grep '"mode": "live"'` to audit what `auto` did.

`auto` is not in LiteLLM's `model_list` — it exists only while the hook is
loaded. If `/add-litellm` is re-run (which drops the hook wiring), requests
for `auto` fail with model-not-found until this installer is re-run. That's
deliberate: loud, not silently unrouted.

To expose it in the webchat Models tab, register a model with kind
**openai-compatible**, endpoint `http://host.docker.internal:4000/v1`, model
id `auto` — assigning it to an agent group behaves like any other
openai-compatible model (the group runs on OpenCode; each turn's model is
picked per prompt).

## Escalation — the confidence floor as a route (Phase 3, §16c)

Arch-Router yields no confidence score, so the floor is realized as an
**escalate route**: a route with `"escalate": true` and **no model binding**
whose description captures work beyond your local roster (the example seeds
one). Live behavior when a prompt classifies there:

- The hook rejects the request **before any generation** with HTTP 400 and a
  `no_adequate_model` marker in the error body.
- The turn fails inside the agent container; if the agent group has a
  **`fallback_provider`** configured, the runner re-runs the turn ONCE on
  that provider with a fresh session (one-shot — a fallback failure never
  re-escalates; the next turn goes back to the primary). The same seam
  catches hard failures: LiteLLM down, backend timeout, dead model.

The `fallback_provider` seam is **not part of trunk** — this skill delivers
it as reversible core-file surgery (same contract as the webchat installer's
hook patches: reverse-check → `git apply --3way` → conflict-restore; new
files copied in). **Prerequisite:** the poll-loop abandoned-query fix
(`fix(poll-loop): abandoned hub queries kept polling`) must be in your
checkout's history — the escalation patches build on its `signal` parameter.
It ships on `channels-webchat`; a checkout current with that branch has it.
Install, then restart the host so the migration runs:

```bash
bash .claude/skills/add-routing/resources/core-escalation/install-core-escalation.sh
# restart the nanoclaw service, then arm a group:
ncl groups config update --id <group-id> --fallback-provider claude
ncl groups restart --id <group-id>
# clear it again with --fallback-provider none
```

The seam is provider-agnostic core plumbing (migration for the
`container_configs.fallback_provider` column, the `ncl` flag, the poll-loop
one-shot retry, the container-runner env/mount merge for the fallback
provider). Re-running the installer is idempotent; upstream drift is absorbed
by the 3-way apply, and a genuine conflict restores the file and reports
instead of leaving markers.

Classifier failures never escalate — only an affirmative classification does.
Escalation costs fallback-provider quota and double latency; it is a
backstop, not a routine path. Shadow mode logs escalate matches as
`"bound_model": "__escalate__"` so you can tune the route description before
arming a fallback. Without a `fallback_provider`, an escalate match surfaces
to the user as an error — don't add the route until the group has a fallback
(or you want a hard refusal).

## Nightly recalibration (Phase 4, §16e tier-1)

Opt-in nightly script over the decision log — no training, no LLM calls:

```bash
bash .claude/skills/add-routing/resources/install-recalibration.sh   # systemd user timer, 03:30
# or run once by hand:
node .claude/skills/add-routing/resources/recalibrate.mjs --days 7
```

What it does each night:

- **Report** (`data/litellm/routing/recalibration-<date>.md`): route
  distribution, classifier error/timeout rate, `other` rate, escalation rate
  as a share of live traffic, classify-latency percentiles — with ⚠ flags
  when a rate leaves its normal band.
- **Auto-tunes ONE knob** (`--apply`, default in the timer):
  `live.timeout_ms` from observed latency (p95 × 1.5, clamped to 2–15s,
  20% deadband so it doesn't thrash). Everything else — route descriptions,
  bindings, the escalate route's aggressiveness — is a recommendation only:
  those are judgment calls, and the whole game is route descriptions.
- **Rotates** log entries older than 30 days to
  `routing-shadow.archive.jsonl` (the rewrite races a concurrent classify
  append in a microscopic window at 03:30 — worst case one shadow line lost).

Arch-Router yields no confidence score, so there is no numeric floor to
recalibrate — the escalation-rate flag is the §16e "escalating 45% but
quality plateaued" signal, pointed at the escalate route's description.

## What this deliberately does NOT do (yet)

The post-flight quality judge (§16d) and router retraining (§16e tier-2) are
later phases and land behind explicit config — never as a side effect of
installing this skill.

## Removal

See [REMOVE.md](REMOVE.md).
