# Design: Shared-room BYOK via per-member containers

**Status:** shipping — the core architecture behind `/add-byok`.
**Extended by:** [byok-oauth.md](byok-oauth.md) — the Claude **subscription** (OAuth) variant builds on everything here.

## 1. Goal

A shared webchat **room** where several people chat in one window, the agent
always has the **full conversation**, and **each person's turn is billed to their
own Anthropic account** — securely, so that a compromised or prompt-injected
agent cannot spend anyone else's key.

Non-goal: a shared/team key. One credential = one human, used only for that
human's own turns.

## 2. Threat model

- **Adversary:** either (a) a compromised / prompt-injected agent running *inside*
  a member's per-member container, or (b) a malicious but authenticated room
  member calling the webchat HTTP API.
- **Protect:** (1) no member can spend or exfiltrate another member's credential;
  (2) credentials never leak via logs, argv, errors, or to other members;
  (3) credentialed-action approvals route to the correct human; (4) no message
  amplification / DoS / session hijack; (5) no cross-user onboarding.
- **Trusted:** the host process, the OneCLI gateway (assumed to enforce
  per-identity secret isolation), and OS file permissions.

## 3. The rejected approach (and why)

The obvious design — one shared container, inject the *active* member's key per
turn — is **unfixably broken**. Any per-turn secret has to reach the shared
container through `inbound.db`, which the container reads, so a compromised agent
can replay a co-participant's token. This is inherent to the shared-container
model, not a bug a patch can close.

That implementation is preserved as a documented dead-end on the
`archive/byok-proxy-deadend` branch. **Do not revive it.**

## 4. Architecture: per-member sessions

Change *where execution happens*, not *how keys are injected*. **Each member's
turn runs in a container bearing that member's own OneCLI agent identity**, and
OneCLI injects that member's key based on the identity it already trusts at
spawn. There is **no per-turn token and no shared secret** — nothing to replay
or steal.

- **Session keying** reuses the existing `per-thread` session mode with
  `thread_id = userId`. No `sessions` schema change and no new mode: a
  key-holder's message routes to a session keyed by their userId, so each member
  gets their own session / container / inbound+outbound DBs per room.
- **The override lives in `deliverToAgent`** (`src/router.ts`), where both the
  userId and the messaging group are in scope. When the room is BYOK and the
  sender has an active key, a registered key-override sets
  `effectiveSessionMode = 'per-thread'` and `sessionThreadId = userId`; otherwise
  routing is unchanged. (The webchat adapter can't do this itself — it sends
  `threadId = null` and the sender is resolved later in the pipeline.)
- **Core stays BYOK-agnostic.** `src/container-runtime.ts` exposes
  `registerAgentIdentityResolver` / `registerContainerEnvResolver` hooks; the
  byok module registers the resolvers. At spawn, `src/container-runner.ts` calls
  `resolveAgentIdentity(agentGroup.id, session.thread_id)` — so the identity is
  derived from **trusted session state, never agent- or user-controllable
  input**.

## 5. Per-member OneCLI identity

`byokAgentIdentifier(agentGroupId, userId)` (`src/modules/byok/identity.ts`)
returns `byok-<userSlug>-<sha256(agentGroupId|userId)[:12]>`:

- Lowercase `[a-z0-9-]` only (OneCLI's identifier constraint), so the raw userId
  (which contains `:` / `@`) is **never embedded or split**.
- Deterministic, so idempotent onboarding and spawn always agree.
- The owning agent group is recovered from the `byok_credentials` table
  (§7/§9), **not** by parsing the identifier.

## 6. Shared context via fan-out

The agent must see the whole conversation even though turns run in separate
per-member containers. `src/modules/byok/fanout.ts` writes each room message into
**every** member's session: `trigger = 1` (wake) only to the sender's session,
`trigger = 0` (context) to the rest; the agent's reply is fanned into the
non-producer sessions as `trigger = 0` too.

**Invariant:** every fan-out write is `trigger = 0` except the sender's own — a
stray `trigger = 1` would N-way amplify. Idle members catch up on the shared
transcript the next time they speak.

## 7. Data model

- **`byok_credentials`** (migration `020-byok-credentials.ts`): PK
  `(user_id, agent_group_id)`; `onecli_agent_id` (the per-member identity the
  container spawns under), `secret_id` (the member's OneCLI vault secret, reused
  across their agent-group rows), `status`, timestamps. An index on
  `onecli_agent_id` powers approval reversal (§9). **Stores only ids + status —
  never the key**, which lives in the OneCLI vault.
- **`webchat_room_settings.credential_mode`**: `disabled` (default) | `optional`
  | `required` (§10).
- The OAuth variant adds a `cred_type` discriminator only; the token lives in the
  OneCLI vault like an API key — see [byok-oauth.md](byok-oauth.md).

## 8. Flow

**Onboard** (member, own key only) — `POST /api/byok/credential`
(`src/channels/webchat/server.ts`): CSRF-guarded, room-access gated, and bound to
the **authenticated** userId (never a body-supplied user). `onboard.ts` then
creates/updates the member's vault secret via `onecli`, ensures the per-member
agent (`byokAgentIdentifier`), sets it to `selective` secret mode, and calls
`setSecrets` with the merged set `{ member secret } ∪ { group tool secrets }`
(reconstructed each time, so siblings are never clobbered), and persists the
mapping in `byok_credentials`. Keys are never logged; `onecli` exec errors are
scrubbed of their argv (so a key can't leak via an error message).

**Route + spawn** — `deliverToAgent` keys the session to the userId (§4);
`container-runner.ts` spawns the container under
`resolveAgentIdentity(group, session.thread_id)` → the member's OneCLI agent →
their key injected by the gateway.

**Revoke** — clears the member's secret/mapping; the per-member OneCLI agent
lingers but is inert (the session simply stops resolving to it). Revoke is the
offboarding lever.

## 9. Approval routing

A credentialed-action approval from a per-member container arrives with
`externalId = byok-<slug>-<hash>` — not an agent-group id.
`src/modules/approvals/onecli-approvals.ts` first tries `getAgentGroup(externalId)`;
on a miss it calls a registered fallback (`registerApprovalAgentGroupFallback`,
provided by the byok module) that reverses the identity via
`byok_credentials(onecli_agent_id → agent_group_id)`. Approver selection then
proceeds normally (scoped admin → global admin → owner). This is **table-based
reversal, not string-splitting** — robust to the identifier charset, and the only
thing keeping BYOK approvals routable (a missing fallback would auto-deny).

## 10. No-key handling

Per the room's `credential_mode`:

- **`disabled`** — one shared agent for the room (default; unchanged behavior).
- **`optional`** — key-holders run per-member; members without a key use the
  shared agent.
- **`required`** — a member without a key is **not woken** (drop reason
  `byok-required-no-key`) and gets connect-your-key guidance; there is no shared
  fallback.

## 11. Security properties

- **No per-turn credential reaches a shared container → no replay** — the flaw
  the proxy approach (§3) could not fix.
- A compromised agent in a member's container holds **only that member's own**
  credential, so it cannot spend or exfiltrate anyone else's.
- The per-member identity is fixed **at spawn from `session.thread_id`**, not
  from any agent-controllable input.
- **Adversarial review (2026-06):** per-member isolation, fan-out discipline,
  approval routing, and onboarding authz all held up. One credential-in-logs
  hygiene finding (an `onecli` exec error embedding the key in its argv) was
  fixed at the `onecli()` chokepoint. Residual operational risks (onboarding
  argv exposure, OneCLI as trust anchor) are catalogued in the `/add-byok`
  SKILL.md "Security review & residual risks" section.

## 12. Touch points

- **BYOK-owned:** `src/modules/byok/` (identity, db, onboard, onecli-admin,
  fanout, crypto, index), migrations `020-byok-credentials.ts` /
  `021-byok-oauth.ts`.
- **Core hooks (additive):** `src/router.ts` (per-member keying + no-key drop),
  `src/container-runtime.ts` (resolver registration), `src/container-runner.ts`
  (spawn identity + env), `src/modules/approvals/onecli-approvals.ts` (approval
  fallback), `src/session-manager.ts`, `src/modules/index.ts`,
  `src/db/migrations/index.ts`, and the webchat `db.ts` / `server.ts` /
  `migration.ts` + the PWA (`public/webchat/`).
