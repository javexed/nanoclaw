# Remove LiteLLM

Reverses everything `/add-litellm` applied. The skill makes **no core-code
edits** — removal is the container + generated files + (optionally) any
consumer-side wiring and OneCLI secrets.

```bash
# 1. Stop and remove the router container
docker rm -f nanoclaw-litellm 2>/dev/null || true

# 2. Remove generated runtime files — includes master.key, the env file
#    (backend key values), and backends.json in keyed installs
rm -rf data/litellm
```

2b. Keyed installs only: delete the "LiteLLM router" master-key secret from
    OneCLI (`onecli secrets list`, then delete by id) — it authenticates
    against an endpoint that no longer exists. The backend keys themselves
    (OpenAI, Anthropic, …) were never in OneCLI via this skill; they lived
    only in `data/litellm/env`, already removed above.

3. Remove any consumer-side wiring that points at the router (endpoint
   `http://host.docker.internal:<port>/v1`) — a webchat model registration,
   an agent group's `OPENCODE_*` env, or any other OpenAI-compatible client
   config — and reassign the agent groups that used it.

4. Dependent skills (classifier routing, etc.) stop working without this base
   — remove them first, or accept their broken state.

5. Delete the skill folder itself if fully retiring: `.claude/skills/add-litellm/`.
