# Design: OAuth (subscription) BYOK via per-member containers

**Status:** prototype (`proto/byok-oauth-onecli`) — reworked from the original
host-encrypted design to **vault-only** (OneCLI carries the token). See §8 for the
re-validation this rework requires.
**Extends:** [byok.md](byok.md) — the per-member-session architecture (session keying, identity derivation, fan-out, approval routing) is defined there; this doc covers only the OAuth/subscription delta.

**Resolved decisions (owner sign-off):**
- §2 gating — **both**: a per-room owner/admin toggle (`oauth_allowed`, default
  off) *and* a per-member own-use acknowledgment. OAuth onboarding requires both.

> **Design revision (this branch).** The original design stored each member's
> OAuth token **host-side, encrypted** (`crypto.ts` + `data/byok-oauth.key`) and
> injected the real token into the container env with `NO_PROXY=api.anthropic.com`
> (Anthropic leg bypassing OneCLI). That worked and was validated end-to-end, but
> it was built on the belief that *"OneCLI cannot carry an OAuth token."* That
> belief is **false**: `src/channels/webchat/drafter.ts` and `setup/auto.ts`
> already route Anthropic OAuth through OneCLI with a placeholder bearer that the
> proxy swaps for the real vault token. This revision makes OAuth BYOK **vault-only,
> same posture as API-key BYOK** — deleting the host-side at-rest token and crypto.

## 1. Goal

Let a member of a shared webchat room run their turns on **their own Claude
Pro/Max subscription** (OAuth), not a metered API key — without violating
Anthropic's terms and without weakening the per-member isolation that the
current BYOK design already guarantees.

Non-goal: a shared/team subscription. One token = one human, always.

## 2. Why this is ToS-defensible

The thing Anthropic's consumer terms forbid is **one subscription serving many
people** (seat-sharing / reselling). The per-member architecture structurally
cannot do that: there are *N* tokens, each used **only for its owner's own
turns, in its owner's own container**. That is *N* individuals each using their
own subscription headlessly — which is exactly what `claude setup-token` is
sanctioned for.

The agent SDK authenticates in **genuine OAuth mode** — it sends the
`anthropic-beta: oauth-2025-04-20` header and presents the real Claude Code
identity/system prompt. OneCLI swaps only the bearer *value* on the wire; it does
**not** fake the Claude Code identity or downgrade the request to API-key mode.
The honest OAuth request shape is preserved end to end.

The schema keys credentials per `(user_id, agent_group_id)`, so one token can
never be attached to multiple members.

## 3. What changes vs. API-key BYOK

| | API-key BYOK | OAuth BYOK (this doc) |
|---|---|---|
| Credential | `sk-ant-…` API key | `sk-ant-oat…` from `claude setup-token` |
| Billing | metered API account | member's Pro/Max subscription |
| At-rest custody | **OneCLI vault** (host never holds it) | **OneCLI vault** (same — host never holds it) |
| Injection | OneCLI proxy swaps in `x-api-key` per request | OneCLI proxy swaps the `Authorization: Bearer` value per request |
| Container env | nothing | sentinel `CLAUDE_CODE_OAUTH_TOKEN=placeholder` (flips OAuth mode only) |
| In-container exposure | never (proxy-injected) | never — container holds only the sentinel |
| Cross-member isolation | ✅ per-member container | ✅ per-member container (unchanged) |

The two kinds now differ only in (a) the token prefix and (b) one sentinel env
var that puts the container's Claude Code in OAuth mode. Both store the real
credential in the OneCLI vault, assigned to the member's per-member agent.

## 4. How the OneCLI OAuth path works

Subscription OAuth requires the SDK to be **in OAuth mode** — it adds
`anthropic-beta: oauth-2025-04-20` and the Claude Code system-prompt identity.
The sentinel `CLAUDE_CODE_OAUTH_TOKEN` (any non-empty value) is what flips the
SDK into that mode; the value itself is irrelevant because:

- The container routes Anthropic **through OneCLI** (no `NO_PROXY`).
- OneCLI holds the member's real `sk-ant-oat…` as the Anthropic secret on the
  member's per-member agent, and **rewrites the `Authorization` header on the
  wire** (`--header-name Authorization --value-format 'Bearer {value}'`, or the
  equivalent behavior of `--type anthropic`).
- The SDK still sends the `anthropic-beta` header and the real Claude Code system
  prompt — so the request that reaches Anthropic is a genuine OAuth request, just
  with its bearer value supplied by the proxy instead of the container.

This is exactly the pattern already in production host-side
(`src/channels/webchat/drafter.ts`) and for the operator's own subscription
(`setup/register-claude-token.sh`, `setup/auto.ts`). OneCLI **still proxies every
other tool** (Gmail, GitHub, …) for the per-member agent, unchanged.

`setup-token` produces a long-lived token, so there is **no refresh-token
custody** — OneCLI holds one long-lived value; re-prompt when it eventually expires.

## 5. Data model

`byok_credentials` (migration `020` adds the table). Migration `021` adds only the
discriminator — **no encrypted-token columns** (the token lives in the vault):

```
ALTER TABLE byok_credentials ADD COLUMN cred_type TEXT NOT NULL DEFAULT 'api_key';
                                                   -- 'api_key' | 'oauth_token'
```

- Both `api_key` and `oauth_token` rows carry `secret_id` (the OneCLI vault
  secret) and `onecli_agent_id` (the per-member agent). The host stores no token.
- `cred_type` drives only (a) presentation and (b) whether the per-member
  container is spawned in OAuth mode (the sentinel env var).

**Per-room toggle** — on `webchat_room_settings` (alongside `credential_mode`):

```
ALTER TABLE webchat_room_settings ADD COLUMN oauth_allowed INTEGER NOT NULL DEFAULT 0;
```

Orthogonal to `credential_mode`. OAuth onboard rejects unless `oauth_allowed = 1`.

## 6. Flow

### Onboard (member, own key only — reuses existing authz)
1. Member runs `claude setup-token` locally → copies `sk-ant-oat…`.
2. In-room banner → "Connect a Claude **subscription** (OAuth)" → paste token +
   tick the own-use acknowledgment.
3. `POST /api/byok/credential` with `{type:'oauth_token', token, acknowledged:true}`:
   - reject unless the room's `oauth_allowed = 1` (gate 1);
   - reject unless `acknowledged === true` (gate 2);
   - validate format (`^sk-ant-oat`), reject otherwise;
   - `onboardByokOauth` → store the token as the member's Anthropic vault secret,
     assign it (+ the group's tool secrets) to the per-member agent, mark
     `cred_type='oauth_token'`. **Never log the token.**

### Spawn (`container-runner.ts`, BYOK session)
The per-member session spawns under the member's OneCLI agent (identity resolver,
unchanged). The module's container-env resolver adds, for OAuth members only, a
sentinel `CLAUDE_CODE_OAUTH_TOKEN=placeholder` (no `NO_PROXY`). OneCLI swaps the
real token on the wire for both kinds; api-key members need no env at all.

### Revoke
Remove the member's secret from the per-member agent (tools left) and mark
revoked — identical for both credential kinds.

## 7. Touch points

- `src/db/migrations/021-byok-oauth.ts` — `cred_type` column only.
- `src/modules/byok/db.ts` — `cred_type` + `userHasActiveOauth()`; one unified
  `upsertByokCredential(…, credType)`. **No crypto, no token columns.**
- `src/modules/byok/onboard.ts` — `onboardByokOauth` shares the API-key path
  (`onboardSecret`), differing only in `cred_type`.
- `src/modules/byok/index.ts` — container-env resolver injects the sentinel for
  OAuth members; **no `NO_PROXY`, no real token**.
- `~~src/modules/byok/crypto.ts~~` — **deleted** (no host-side at-rest token).
- `src/channels/webchat/migration.ts` + `db.ts` — `oauth_allowed` column +
  get/set; credential endpoint; room toggle.
- `public/webchat/{app.js,index.html}` — room OAuth toggle + connect mode.

No agent-runner change → **no container rebuild**. No new npm deps.

## 8. Risks / open questions

> The **original** host-encrypted + `NO_PROXY` design was validated end-to-end on
> 2026-06-12 (including a real subscription token → clean completion). This
> revision changes the transport, so two things need **re-validation** before it
> replaces the shipped path:

1. **Sentinel acceptance** — does the container's Claude Code accept a
   `CLAUDE_CODE_OAUTH_TOKEN=placeholder` (non-real) value to enter OAuth mode
   *without locally validating/decoding it* before the first request? The drafter
   proves OneCLI swaps the bearer, but it hand-builds the HTTP request, so it does
   **not** exercise Claude Code's token-loading path. **NEEDS A LIVE TEST.** If
   Claude Code pre-validates, use a validly-shaped but inert token, or fall back
   to the original env-injection.
2. **OneCLI container swap for `--type anthropic` oat** — confirm OneCLI rewrites
   the `Authorization: Bearer` for a *container* request (not just the host-side
   `getContainerConfig` path the drafter uses) when the member's secret is an
   `sk-ant-oat…` value. Fallback: store it as `--type generic --header-name
   Authorization --value-format 'Bearer {value}'` (the `setup/auto.ts` mechanism).
3. **Token longevity / expiry UX** — expired `setup-token` → 401; surface a
   "reconnect your subscription" banner, not a silent failure.
4. **In-container exposure — now eliminated.** The container holds only the
   sentinel; the real token never enters it (strictly better than the original,
   which put the real token in env).
5. **ToS drift** — if Anthropic later restricts headless subscription use, disable
   this opt-in credential type without touching API-key BYOK.

## 9. Test plan

- Unit (✅ this branch): `db.ts` cred_type + `userHasActiveOauth`; onboard OAuth
  branch stores the vault secret (no host token); revoke removes the secret.
- Spawn: BYOK oauth session → container args contain a sentinel
  `CLAUDE_CODE_OAUTH_TOKEN` and **no** `NO_PROXY`; api_key session unchanged.
- Live (§8.1/8.2): real `setup-token` → one message round-trips on the
  subscription through OneCLI; `onecli` shows the member's oat secret on their
  agent; revoke → 401/declined.
- Regression: API-key BYOK and non-BYOK rooms untouched.

## 10. Recommendation

Make OAuth BYOK **vault-only**, identical in posture to API-key BYOK, by reusing
the OneCLI bearer-swap already proven in the drafter and operator-subscription
paths. This deletes the host-side encrypted store and removes the in-container
token exposure. Gate the cutover on the §8.1/8.2 live re-validation; keep the
original env-injection path available as a fallback until then.
