# NanoClaw webchat — security additions

Fork-specific security behavior, kept out of the upstream [docs/SECURITY.md](../SECURITY.md)
so that file stays a clean mirror of `nanocoai/nanoclaw`. Everything here layers
on top of the upstream model — read that first; this documents only what the
webchat fork adds or changes.

## Per-agent-group egress

Extends upstream **§5 Egress Lockdown (Forced Proxy)** with a per-group control:
`container_configs.egress`, set via
`ncl groups config update --egress open|host-only|none`.

| Mode | Meaning |
| --- | --- |
| `open` (default / NULL) | Full egress via the host gateway. |
| `host-only` | THIS group joins the same lockdown network/mechanism, regardless of the install-wide flag — host services (OneCLI, LiteLLM, the MCP relay) reachable, internet not. |
| `none` | `--network none` — no network at all, for fully local agents. |

Most restrictive wins; `host-only` reuses the exact lockdown machinery (same
network, same gateway aliasing, same fail-fast contract) as the install-wide
`NANOCLAW_EGRESS_LOCKDOWN` flag.

## Container hardening & resource limits

Supersedes upstream **§Resource Limits** for this fork. Every agent container
runs with a hardened baseline (the image runs as `node` under tini and never
escalates, so dropping everything costs nothing):

```
--cap-drop ALL
--cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER
--security-opt no-new-privileges
--pids-limit 512
```

| Env | Default | Meaning |
| --- | --- | --- |
| `NANOCLAW_CONTAINER_NO_HARDEN` | *(unset)* | `1` disables the baseline — an escape hatch for a workload a dropped capability genuinely breaks. Report it; don't live there. |
| `NANOCLAW_CONTAINER_PIDS_LIMIT` | `512` | Fork bombs become a contained failure, not a host reboot. |
| `CONTAINER_MEMORY_LIMIT` | `8g` | **Hard memory cap by default** — a runaway agent has OOM-killed real installs; unbounded-by-default privileges the failure case. Set the literal `none` to restore unbounded. |
| `CONTAINER_CPU_LIMIT` | *(empty — unbounded)* | `--cpus` when set. CPU stays opt-in: contention degrades, it doesn't take the host down. |

On a swapless host `--memory` is a hard cap and a runaway is OOM-killed at the
limit.

## Approval TTL

A pending approval that nobody answers **denies itself** after
`NANOCLAW_APPROVAL_TTL_HOURS` (default `24`, `0` disables). Expiry goes through
the same `finalizeReject` path a human deny uses: the agent is told, cards flip
on every surface, and the container wakes to see the outcome. Rationale: a stale
approval is its own hazard — a request finally tapped three days later executes
in a context nobody remembers.

## Credential redaction in surfaced errors

Error text that reaches chat rooms (provider failures, terminal errors,
unwrapped error results) passes through `redactSecrets()` in the agent-runner:
key shapes (`sk-…`, `ghp_…`, `aoc_…`, `mcr_…`), `Bearer` tokens, and
`key=`/`token=`/`password=` parameters become `[REDACTED]`. OneCLI means
containers rarely hold real secrets — this is the belt for the ones that exist
(MCP bearer tokens, relay tokens, operator-pasted keys).
