# Remove LiteLLM

Reverses everything `/add-litellm` applied. The skill makes **no core-code
edits** — removal is the container + generated files + (optionally) the
webchat registration and OneCLI secrets.

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

3. If a webchat model was registered pointing at the router
   (`openai-compatible`, endpoint `http://host.docker.internal:<port>/v1`),
   delete it from the webchat Models UI and reassign any agent groups that
   used it.

4. Dependent skills (classifier routing, etc.) stop working without this base
   — remove them first, or accept their broken state.

5. Delete the skill folder itself if fully retiring: `.claude/skills/add-litellm/`.
