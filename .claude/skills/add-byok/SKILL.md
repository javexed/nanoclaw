---
name: add-byok
description: Secure shared-room BYOK — many people in one webchat room, each billed to their own Anthropic account, with the agent seeing the full conversation. Each member's turn runs in its own container under their OneCLI identity (keys in the OneCLI vault), so a compromised agent can't spend anyone else's key. Coexists with OneCLI.
---

# Add Secure Shared-Room BYOK

Multiple people share **one** webchat room and conversation, but **each person's turn is billed to their own Anthropic account** — securely. This is the architecture that survived review (an earlier per-turn-token credential proxy had an unfixable replay flaw and was retired).

## Why this is secure (and the proxy wasn't)

A shared container can't be told "whose turn this is" in a way a compromised/prompt-injected agent can't forge. So instead of one shared container, **each member's turn runs in its own container under their own OneCLI agent identity** — and OneCLI injects that member's key based on the identity it already trusts at spawn. There is **no per-turn token and no shared secret**, so there is nothing to replay or steal. The agent still has full context because every member's session is fed the **shared room transcript**.

- **Per-member execution**: a key-holder's message routes to a session keyed by their userId; that container spawns under `byok-<member>-<hash>` (their OneCLI agent → their key).
- **Shared context**: on each member's turn, the full recent room transcript is written into their session (current message wakes; the rest is context). Idle members catch up when they next speak.
- **Keys in the OneCLI vault** — onboarding shells to `onecli` (no custom crypto). We persist only ids/status, never the key.
- **Coexists with OneCLI**: the member's per-member agent also mirrors the group's non-anthropic tool secrets, so tools still work. Non-BYOK rooms are untouched.

## Prerequisites

- **Webchat installed** (`/add-webchat`) — the installer aborts otherwise.
- **OneCLI** running (`/init-onecli`) — keys live in its vault.

## Install

```bash
git checkout <remote>/skill/byok -- install-byok.sh
./install-byok.sh
```

Idempotent. No npm deps, no agent-runner change → **no container rebuild**. Leaves changes unstaged for review.

## Configure (secure by default — rooms start `disabled`)

1. **Per room** (owner/admin) → Room settings → *Personal API keys (BYOK)*:
   - `disabled` — one shared agent for the room (default; unchanged behavior)
   - `optional` — members may connect their own key; those who don't use the shared key
   - `required` — every member must connect their own key (no shared fallback; a member without one is declined with guidance)
2. **Each member** → the in-room banner → *Connect your key* (paste `sk-ant-…`). Their turns then bill their account. *Disconnect* removes it.

### Optional: Claude **subscription** (OAuth) instead of an API key

A member can bill their turns to their own Claude Pro/Max **subscription** rather
than a metered API key. This is gated twice (secure by default):

1. **Per-room** (owner/admin) → Room settings → tick *Allow members to connect
   their Claude subscription (OAuth)* (off by default).
2. **Per-member** → the banner shows *Use my Claude subscription* → run
   `claude setup-token` locally, paste the `sk-ant-oat…` token, and tick the
   own-use acknowledgment.

**Why it's compliant:** each member uses **their own** subscription for **their
own** turns in **their own** per-member container — this is `setup-token`'s
sanctioned headless use, not seat-sharing (the schema forbids one token across
members).

**The tradeoff:** OneCLI can't carry an OAuth token (no refresh, can't put the
SDK in OAuth mode), so the **host stores the token encrypted** at rest
(`data/byok-oauth.key`, AES-256-GCM) and injects `CLAUDE_CODE_OAUTH_TOKEN` into
the member's container at spawn, with the Anthropic leg bypassing OneCLI
(`NO_PROXY=api.anthropic.com`); OneCLI still proxies all other tools. Unlike the
API-key path, the host *can* decrypt these tokens. See
[docs/design/byok-oauth.md](../../../docs/design/byok-oauth.md).

## Security review & residual risks

This architecture passed an adversarial security review — per-member isolation,
the no-per-turn-token model, fan-out discipline, approval routing, and own-key
onboarding all held up. One credential-hygiene finding was fixed: `onecli` exec
errors are now scrubbed, so a member's key can never reach the host log through
an error message.

None of the items below are cross-member key theft, but an operator should know
them when deciding how far to harden:

- **API key briefly in the process list during onboarding.** `onecli` (1.2.x)
  takes the secret as a `--value` argument, so the key is momentarily visible in
  `ps` / `/proc` on the host while it's stored. Fine on a single-operator host;
  on a shared host, restrict who can read other users' processes.
- **OAuth tokens are host-decryptable.** Unlike API keys (OneCLI-vault only), a
  connected Claude **subscription** token is stored encrypted at
  `data/byok-oauth.key` (AES-256-GCM, mode 0600). That key file is the crown
  jewel — keep its filesystem perms tight, include it in your (encrypted)
  backups, and treat host compromise as token compromise. Rotation = the member
  reconnects; *Disconnect* wipes the stored token.
- **The OAuth leg bypasses the OneCLI gateway.** For subscription members,
  `NO_PROXY=api.anthropic.com` sends that one host straight to Anthropic with the
  member's token, so egress-lockdown / gateway policy doesn't cover it. The
  bypass is scoped to `api.anthropic.com` only — keep it that way.
- **Revoke stops resolution; it doesn't delete the identity.** Disconnecting
  wipes the member's secret/token; the per-member OneCLI agent lingers but is
  inert (the session simply stops resolving to it). Revoke is the offboarding
  lever.
- **Trust anchor: OneCLI.** The whole model rests on the OneCLI gateway
  enforcing per-identity secret isolation. Confirm that holds for your deployed
  OneCLI version before relying on BYOK in a hostile room.

## Uninstall

```bash
git checkout <remote>/skill/byok -- uninstall-byok.sh
./uninstall-byok.sh
```

Reverses every hook, removes BYOK files, rebuilds. Leaves the `byok_credentials`
table + the OneCLI vault secrets/agents (manage those via `onecli`).

## ⚠️ Live-validation note

The `onecli` JSON shapes for list operations are confirmed; the create/update/
set-secrets calls in onboarding should be exercised once against the live
gateway before relying on them in production (the orchestration logic is
unit-tested with a fake admin).

## Files

- **BYOK-owned (copied):** `src/modules/byok/` (identity, db, onecli-admin, onboard, fanout, crypto, index), `src/db/migrations/020-byok-credentials.ts`, `src/db/migrations/021-byok-oauth.ts`.
- **Hooks (reversible 3-way patch):** `src/session-manager.ts`, `src/router.ts`, `src/container-runtime.ts`, `src/container-runner.ts`, `src/modules/index.ts`, `src/modules/approvals/onecli-approvals.ts`, `src/db/migrations/index.ts`, and the webchat files `migration.ts`, `migration.test.ts`, `db.ts`, `server.ts`, `public/webchat/{app.js,index.html,style.css}`. (No agent-runner files.)
