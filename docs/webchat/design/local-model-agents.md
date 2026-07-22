# Running agents on local models (opt-in, alongside Claude)

**Status:** how-to + evaluation protocol. Claude stays the default; this adds a
local model as a *per-agent* driver you opt into. Nothing here removes or
replaces Claude — an unassigned agent group still runs on it.

Related: [add-litellm.md](add-litellm.md) (the OpenAI-compatible proxy),
[llm-router.md](llm-router.md) (prompt-aware routing over that proxy). This doc
is the layer above: pointing an actual **agent** at a local model and judging
whether the model is good enough to *drive* one.

## The idea

A NanoClaw agent group has a `provider` (default `claude`, via the Claude Agent
SDK). Assigning an agent group an **openai-compatible** model points the default
Claude harness at **LiteLLM's Anthropic-spec `/v1/messages` surface** (via
`ANTHROPIC_BASE_URL`), and LiteLLM at a local **Ollama** model, so the agent now
runs entirely on local inference — no Anthropic call in the turn, and no separate
harness hop: the Claude SDK talks to LiteLLM natively. This path already exists;
this doc is about *using* it deliberately and evaluating the result.

Because it's per-agent, it's additive and reversible:

- Claude remains the default for every agent group you don't touch.
- You flip one throwaway agent to a local model, judge it, and flip it back (or
  keep it) — nothing else is affected.
- Optionally leave `fallback_provider: claude` on the local agent so terminal
  errors re-run the turn on Claude (see llm-router.md §16c). That keeps a safety
  net while you're evaluating.

## Prerequisites

1. **A local model served + reachable through LiteLLM.** Easiest is Ollama +
   `/add-litellm`, which stands up the proxy on `:4000`. Verify the model shows
   in the roster: `curl -s http://127.0.0.1:4000/v1/models`.
2. **The model registered as an assignable openai-compatible model.** In the
   webchat **Models** tab, add a model: kind **openai-compatible**, endpoint
   `http://host.docker.internal:4000/v1` (the container's view of the host's
   LiteLLM), model id = the Ollama model name (e.g. `ornith:latest`). Or insert
   the `webchat_models` row directly. (`auto` and the routing profiles are just
   the same registration pointed at the virtual router model — see llm-router.md.)

## Pointing an agent at a local model

Assign the registered model to a **throwaway test agent group** — never a live
one for a first run. Either:

- **Webchat:** the agent's settings panel → model picker → the registered local
  model.
- **CLI:** `ncl groups config update --id <group> --model <model-id>`
  then restart so the container respawns on the new config:
  `ncl groups restart --id <group>`.

The next turn runs on the default Claude harness pointed at LiteLLM + the local
model. Revert by clearing the model (back to Anthropic) and restarting.

## What to expect at small model sizes

The honest read, because it dominates the experience. Model capability — not the
wiring — is the whole question.

- **7–9B models** (e.g. `ornith:latest` ≈ 9B Qwen3.5 code-tuned, `gemma4:latest`
  ≈ 8B Gemma) are a real step up from the 3–4B models used for prompt routing,
  but still small for *agentic driving* (tool-calling, the `ncl` CLI, MCP tools,
  multi-step plans, CLAUDE.md fidelity). NanoClaw's loop was tuned around
  Claude's tool-use reliability.
- **Code/Qwen-family models tend to drive better** — they emit cleaner tool
  syntax and structured output. A code-tuned ~9B is a reasonable bet for direct
  Q&A, single-tool tasks, and *most* 2–3 step chains.
- **General/Gemma-family models write better prose but fight the tool loop** —
  historically weaker at strict function-calling discipline, so expect nicer
  replies but more friction on `ncl`/MCP calls (re-calling a tool, slipping the
  format, narrating instead of acting).
- **The common failure mode isn't a wrong answer — it's losing the plot on a
  long chain** (derailing around step 3–4, repeating a tool call, forgetting the
  task mid-way). The Claude harness structures the tool-calls and softens this,
  but doesn't erase it.

Treat anything below ~30B as "good for simple-to-moderate agent tasks, shaky on
long multi-step work." If you need reliable long-horizon agentic work locally,
you're looking at a 30B-class model on 24GB+ VRAM (Qwen3-Coder-30B,
Devstral-Small-24B, GLM-4.x, Qwen2.5-Coder-32B).

## Evaluation protocol — is this model a good enough driver?

Use **one throwaway agent in a dedicated room** (e.g. `#local-lab`) and run a
small fixed battery. Then **flip the same agent to the next model and run the
identical battery** — same prompts, same room, only the model changes, so it's a
clean A/B.

Suggested battery (escalating tool demand):

1. **Plain Q&A, no tools** — baseline coherence. ("Explain what this agent does
   in two sentences.")
2. **Single-tool task** — forces exactly one tool call.
   ("What rooms am I wired to?" → one `ncl` call; or "what's in the workspace?"
   → one file listing.)
3. **2–3 step task** — read something, act on it, report back.
   ("Check the workspace for a TODO file, summarize it, and tell me the top item.")
4. **Recovery** — hand it a deliberately wrong instruction and see if it
   notices/asks, or blindly proceeds.

What to capture for each model × task:

- Did it call the right tool, with valid syntax, first try? (or retries / made-up
  tool / wrong args)
- Did it complete the chain, or derail / loop / stop early?
- Did it follow the room's CLAUDE.md persona/format, or drift?
- Latency per turn (local inference + tool round-trips).

Score each task pass / partial / fail and keep the transcript — the transcript
is the evidence. A model that's clean on tasks 1–2 and shaky on 3–4 is the
expected ~8–9B result and is still useful for lightweight agents; a model that
fails task 2 (can't reliably make one tool call) isn't ready to drive an agent.

## Keeping Claude in the picture

- Unassigned agent groups stay on Claude — no change.
- On the local test agent, `fallback_provider: claude` re-runs a *failed* turn on
  Claude, so a bad local turn degrades gracefully instead of dead-ending. Drop it
  if you want to see the model's raw, unassisted behavior.
- The routing `escalate` route (llm-router.md §16c) is the prompt-level version:
  prompts the classifier judges as beyond the local roster get handed up. Point
  it at Claude, a bigger local model, or turn it off — your call per install.
