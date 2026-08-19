---
name: add-grok
description: Use Grok Build (xAI's coding agent) as a full agent provider — ACP over stdio, tool orchestration, session resume, native CLAUDE.md/AGENTS.md reading — alongside or instead of Claude. Driven by a SuperGrok or X Premium+ subscription via device-code login, never an API key. Per-group via `ncl groups config update --provider grok`.
---

# Grok agent provider

NanoClaw selects each group's agent backend from `container_configs.provider` (default `claude`). This skill installs the Grok provider: copy the payload from the fork's `providers-grok` branch, append one import to each of the three provider barrels, rebuild the image (which installs the pinned Grok CLI), then run the device-code auth walk-through.

The provider runs `grok agent stdio` as a child process speaking ACP — JSON-RPC over stdin/stdout. The continuation is an ACP sessionId, which resumes across process **and** container restarts because the CLI's session store is mounted per agent group.

Credentials are **subscription-only**: a device-code login stores the refresh token on the host, outside any container mount, and only a short-lived access token is materialised into the container. No `XAI_API_KEY` is used or needed.

The mechanical steps under **Install** carry `nc:` directive fences: an agent reads the prose and applies them, and a parser can apply them deterministically from the same document. Every directive is idempotent, so the whole skill is safe to re-run.

## Install

### Pre-flight

Check whether the payload is already wired. All of these present means installed — skip to **Authenticate**:

- `src/providers/grok.ts` and `src/providers/grok-auth.ts`
- `container/agent-runner/src/providers/grok.ts` and `grok-acp.ts`
- `setup/providers/grok.ts`
- `import './grok.js';` in all three provider barrels
- `ARG GROK_VERSION` in `container/Dockerfile`

### 1. Fetch and copy the payload

Fetch the **`providers-grok`** branch and copy the payload into all three trees (additive — overwrite each file, never merge the branch).

> **Read this before applying.** Unlike `/add-codex`, this payload includes `container/Dockerfile` and `container/build.sh`, because the Grok CLI is a native binary and cannot go in the npm-shaped `container/cli-tools.json`. `nc:copy` **overwrites**. If this install carries local edits to either file, re-apply them after copying — or port just the `ARG GROK_VERSION` block by hand and drop those two lines from the copy list.

```nc:copy from-branch:providers-grok
src/providers/grok.ts
src/providers/grok-auth.ts
src/providers/grok.test.ts
src/providers/grok-auth.test.ts
container/agent-runner/src/providers/grok.ts
container/agent-runner/src/providers/grok-acp.ts
container/agent-runner/src/providers/grok.test.ts
container/agent-runner/src/providers/grok-acp.test.ts
container/agent-runner/src/providers/grok-registration.test.ts
setup/providers/grok.ts
setup/providers/grok.test.ts
container/grok-cli-pin.test.ts
container/Dockerfile
container/build.sh
```

### 2. Wire the barrels

Append the self-registration import to each of the three provider barrels (skipped if already present). Each registration test imports its real barrel and asserts `grok` is registered — they go red the moment a barrel line is missing or drifts.

```nc:append to:src/providers/index.ts
import './grok.js';
```
```nc:append to:container/agent-runner/src/providers/index.ts
import './grok.js';
```
```nc:append to:setup/providers/index.ts
import './grok.js';
```

### 3. Build

The image build installs the pinned Grok CLI. `ARG GROK_VERSION=1.0.5` in `container/Dockerfile` is the canonical pin — this SKILL.md and that ARG are the source of truth. Override per-install with `GROK_VERSION=` in `.env`.

```nc:run effect:build
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
```

### 4. Validate

```nc:run effect:test
pnpm vitest run src/providers/grok.test.ts src/providers/grok-auth.test.ts setup/providers/grok.test.ts container/grok-cli-pin.test.ts
```
```nc:run effect:test
cd container/agent-runner && bun test src/providers/grok-acp.test.ts src/providers/grok.test.ts src/providers/grok-registration.test.ts
```

`container/grok-cli-pin.test.ts` guards the packaging invariants that only fail at spawn time: the version stays pinned, the binary installs outside `~/.grok` (which the provider mounts over), and it is dereferenced into a file the unprivileged `node` user can execute.

## Authenticate

```nc:run effect:external
pnpm exec tsx setup/index.ts --step provider-auth grok
```

Runs a device-code login inside a throwaway container: a URL and a short code appear, you confirm on any device with a browser. The resulting refresh token is stored on the host under `data/grok/`; containers only ever receive a short-lived access token. Idempotent — re-running replaces the stored credential, which is also how you recover an expired or revoked session.

One login serves every agent group. A per-group credential file overrides it when present, for a second subscription or a deliberately separate identity.

## Use it

Point a group at Grok:

```bash
ncl groups config update --id <group-id> --provider grok
ncl groups restart --id <group-id> --message "switched to grok"
```

Models available on a subscription are `grok-4.6` (default) and `grok-4.5`. Set one with `--model`.

Do **not** change `DEFAULT_AGENT_PROVIDER` — installed is not authenticated, and a new group defaulting to an unauthenticated provider fails at first message.

## Notes and troubleshooting

**"grok: not found" at spawn.** The image was built without the CLI, or the Dockerfile edit was lost. Check `ARG GROK_VERSION` is present in `container/Dockerfile` and rebuild.

**Every room goes silent after switching.** Check credentials exist: `data/grok/credentials.json` should be present and `0600`. If missing, re-run the auth step.

**Resumed sessions repeat themselves.** That would mean replayed history is being forwarded as content — the provider drops it deliberately. Re-run the container provider tests; `grok-acp.test.ts` pins the replay window.

**Memory across a provider switch.** Grok reads `CLAUDE.md` and `AGENTS.md` natively, so a group's existing project doc carries over without conversion. Conversation history does not — the continuation is provider-specific. See `docs/provider-migration.md`.
