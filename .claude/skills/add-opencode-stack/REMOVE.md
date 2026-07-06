# Remove the OpenCode stack

Reverse of install order — unwire groups first, then the router, then the
provider. Each stage is optional: remove only the layers you no longer want
(e.g. keep OpenCode + LiteLLM but return a group to Claude).

## 1. Unwire groups from the router

For each group you pointed at the router, set it back to the built-in provider
and restart:

```bash
ncl groups config update --id <agent-group-id> --provider claude
ncl groups restart --id <agent-group-id> --message "reverted to Claude"
```

Remove any `OPENCODE_*` router values you added for these groups (per
`/add-opencode`'s Configuration). If the webchat channel is installed and you
registered router models in its Models UI, unassign and delete them there.

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
