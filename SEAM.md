# SEAM — the fork's drift ledger

This branch is upstream (`nanocoai/nanoclaw`) plus a short series of commits.
Everything the fork adds lives in fork-owned files; upstream files carry only
the call sites listed here. If a carry touches an upstream file that is NOT on
this list, something non-hook has crept in.

```
git diff --stat upstream/main pub/module-hooks      # the whole surface
git log upstream/main..pub/module-hooks             # the series
```

## Fork-owned files (never conflict)

| path | what |
|---|---|
| `src/seam/` | host hook registries + the barrel modules import from (`src/seam/index.ts`) |
| `container/agent-runner/src/seam/` | container hook registries + barrel; `providers/hooks.ts` and `runner-hooks.ts` are the older seam files, re-exported by the barrel |
| `src/*.seam.test.ts`, `src/drivers/*.seam.test.ts` | seam tests (host) |
| `.forgejo/workflows/ci.yml` | the fork's CI; its presence makes Forgejo ignore upstream's `.github/workflows` |

## Upstream files touched — 13 files, +188 −0

**Insertions only. No upstream line is changed or removed.** Each insertion is
marked `// seam` or `// Seam:`. Where the fork needs an upstream call to behave
differently, it rebinds the name for the rest of the function (router) or spreads
an override last into the literal (container-runner, claude).

A hook earns its place here only when a fork feature genuinely needs core to
behave differently — not merely to observe it. Observers that can read state a
module already owns live entirely in fork files and cost zero lines here (e.g.
the status feed creates its own table on first write; periodic module work runs
on the fork's own timer).

| file | + | insertion points |
|---|---|---|
| `container/agent-runner/src/poll-loop.ts` | +75 | provider-message observers at batch/turn boundaries; module commands (defer/rewrite); turn context; turn retry |
| `src/router.ts` | +48 | delivery plan replaces engage evaluation; turn veto; the three re-key-sensitive calls (resolveSession, writeSessionMessage, fanInboundMessage) rebound to seam wrappers for the rest of deliverToAgent — their upstream lines untouched |
| `src/modules/approvals/primitive.ts` | +18 | listRegisteredApprovalActions (reads the private handler map, the one thing that must); intercepts + requested-listeners after the row is created |
| `src/container-runner.ts` | +10 | pre-spawn hooks; gateway key re-pointed by a trailing spread; container-exit observer; module env into the contributed lane |
| `src/drivers/index.ts` | +7 | network policy resolver ahead of the built-in rules; honours spec.network; a test-only alias so the seam test needs no export change |
| `src/modules/agent-to-agent/agent-route.ts` | +6 | route observers after a performed route |
| `container/agent-runner/src/providers/claude.ts` | +5 | tool-use observer; module per-query options spread last into the SDK options |
| `src/delivery.ts` | +4 | session delivery observers after both polls; producing session passed to deliver() |
| `container/agent-runner/src/providers/types.ts` | +8 | `QueryInput.moduleInput` — module-owned per-query markers; a field rather than a side table so a wrapper copying the input cannot silently drop them |
| `container/agent-runner/src/destinations.ts` | +2 | module prompt sections appended to the destinations prompt |
| `src/channels/adapter.ts` | +2 | InboundEvent.message.senderAgentGroupId (nested literal — not augmentable) |
| `src/container-config.ts` | +2 | module config augmentation assigned over the DB-backed config |
| `src/index.ts` | +1 | forward senderAgentGroupId onto the routed event |

## Rules

- A new hook goes in `src/seam/` (or the container `seam/`), exported from the barrel, and gets ONE call line in the upstream file.
- Never change, reformat or re-indent an upstream line. Insert above or below it. To alter what an upstream call does, rebind the name locally (`const { x } = seamWrap(…)`) or spread an override last into its object literal.
- Before adding a hook, ask whether the feature can READ state instead: a module that owns a table, a WeakMap keyed by an object it constructs, or its own timer needs no upstream line.
- Optional fields and methods on upstream interfaces are added by `declare module` augmentation in the seam file, not by editing the interface.
- Modules import from the barrels only, never from an upstream file's re-export.
- Keep the series short: a fix goes INTO the commit it belongs to, not on top.
