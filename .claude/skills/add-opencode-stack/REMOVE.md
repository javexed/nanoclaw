# Remove the OpenCode stack

Reverse of install order — models first (they reference the router), then the
router, then the provider. Each stage is optional: remove only the layers you
no longer want (e.g. keep OpenCode + LiteLLM but drop the registered models).

## 1. Unregister the routed models

Unassign any agent still using one (webchat Models UI — unassigning reverts
the agent to the default Claude provider), then delete the registered rows.
From the checkout:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "DELETE FROM webchat_models WHERE kind='openai-compatible' AND endpoint LIKE 'http://host.docker.internal:%'"
pnpm exec tsx scripts/q.ts data/v2.db \
  "DELETE FROM webchat_agent_models WHERE model_id NOT IN (SELECT id FROM webchat_models)"
```

(Deleting via the Models UI instead is equivalent and prompts per assignment.)

## 2. LiteLLM router

Follow `/add-litellm`'s REMOVE.md — container, `data/litellm/` (including
`master.key`/`env` if keyed mode was armed), and any OneCLI secret created
for the router.

## 3. OpenCode provider

Follow `/add-opencode`'s REMOVE.md — both barrels, the copied provider files,
the `@opencode-ai/sdk` dependency, the Dockerfile lines, and an image rebuild.

## 4. This skill's files

```bash
rm -rf .claude/skills/add-opencode-stack
```
