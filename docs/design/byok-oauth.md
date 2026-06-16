# Design: OAuth (subscription) BYOK via per-member containers

**Status:** approved — building on `feat/byok-per-member`
**Extends:** `feat/byok-per-member` (per-member API-key BYOK, already shipping)

**Resolved decisions (owner sign-off):**
- §8.3 host-can-decrypt at-rest store — **accepted.**
- §2 gating — **both**: a per-room owner/admin toggle (`oauth_allowed`, default
  off) *and* a per-member own-use acknowledgment. OAuth onboarding requires both.

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

The agent SDK (the Claude Code engine) authenticates in genuine OAuth mode and
presents as Claude Code legitimately — no identity spoofing. The compliant path
is the honest one; the only way to keep the token *out* of the container would
be a proxy faking the Claude Code identity, which is the path we explicitly
reject.

**Guardrails (both required for OAuth onboard):**
1. **Per-room toggle** — owner/admin sets `oauth_allowed` on the room
   (default **off**). A room never accepts OAuth tokens unless explicitly opted
   in, independent of its API-key `credential_mode`.
2. **Per-member acknowledgment** — "I am connecting *my own* Claude subscription
   for *my own* use."

The schema keys credentials per `(user_id, agent_group_id)`, so one token can
never be attached to multiple members.

## 3. What changes vs. API-key BYOK

| | API-key BYOK (shipping) | OAuth BYOK (this doc) |
|---|---|---|
| Credential | `sk-ant-…` API key | `sk-ant-oat…` from `claude setup-token` |
| Billing | metered API account | member's Pro/Max subscription |
| At-rest custody | **OneCLI vault** (host never holds it) | **host-side, encrypted** (OneCLI can't carry it) |
| Injection | OneCLI proxy injects `x-api-key` per request | `CLAUDE_CODE_OAUTH_TOKEN` env at spawn; Anthropic leg bypasses OneCLI |
| In-container exposure | never (proxy-injected) | token in container env (same as Claude Code on your own laptop) |
| Cross-member isolation | ✅ per-member container | ✅ per-member container (unchanged) |

The **one genuine new cost**: OneCLI cannot inject an OAuth token (no refresh,
can't put the SDK in OAuth mode), so the host stores each member's token
encrypted at rest and injects it at spawn. Bounded to opt-in OAuth members.

## 4. Why OneCLI is out of the Anthropic path (and only that path)

- OneCLI is a static MITM injector: secret types `anthropic`(→`x-api-key`) or
  `generic`(→one custom header). Verified: its whole CLI surface has **no
  oauth/refresh** concept.
- Subscription OAuth requires the SDK to be *in OAuth mode* — it adds
  `anthropic-beta: oauth-2025-04-20` and the Claude Code system-prompt identity.
  Proxy-injecting a bearer while the SDK believes it's in API-key mode produces
  the wrong system prompt → rejected and/or ToS-adjacent. So the SDK must hold
  the token.
- Therefore for OAuth members: `NO_PROXY=api.anthropic.com` (SDK talks directly
  with its bearer); OneCLI **still proxies every other tool** (Gmail, GitHub,
  etc.) exactly as today. Only the Anthropic leg is direct.

`setup-token` produces a long-lived token, so there is **no refresh-token
custody** — we store one long-lived value, re-prompt when it eventually expires.

## 5. Data model

Extend `byok_credentials` (migration `016` adds the table; a new migration adds
columns — never edit a shipped migration):

```
ALTER TABLE byok_credentials ADD COLUMN cred_type TEXT NOT NULL DEFAULT 'api_key';
                                                   -- 'api_key' | 'oauth_token'
ALTER TABLE byok_credentials ADD COLUMN oauth_token_enc BLOB;  -- AES-256-GCM, null for api_key rows
ALTER TABLE byok_credentials ADD COLUMN oauth_token_nonce BLOB;
```

- `api_key` rows are unchanged: `secret_id` / `onecli_agent_id` populated, no
  encrypted blob. OneCLI remains the vault.
- `oauth_token` rows: `oauth_token_enc`/`_nonce` populated; `secret_id` may be
  null (no Anthropic secret in OneCLI). `onecli_agent_id` still set — the
  per-member agent still exists for the group's **tool** secrets.

**Encryption key:** a host-local key (e.g. `data/byok-oauth.key`, `0600`,
generated on first OAuth onboard). Decryptable only by the host process. This is
the deliberate cost of OAuth: the host can decrypt these tokens. Documented, not
hidden.

**Per-room toggle** — add to `webchat_room_settings` (the table that already
holds `credential_mode`):

```
ALTER TABLE webchat_room_settings ADD COLUMN oauth_allowed INTEGER NOT NULL DEFAULT 0;
```

Orthogonal to `credential_mode`: a room may be `optional` API-key BYOK *and*
allow OAuth, or `required` and forbid OAuth, etc. OAuth onboard rejects unless
`oauth_allowed = 1`.

## 6. Flow

### Onboard (member, own key only — reuses existing authz)
1. Member runs `claude setup-token` locally → copies `sk-ant-oat…`.
2. In-room banner → "Connect a Claude **subscription** (OAuth)" → paste token +
   tick the own-use acknowledgment.
3. `POST /api/byok/credential` with `{type:'oauth_token', token, acknowledged:true}`:
   - reject unless the room's `oauth_allowed = 1` (gate 1);
   - reject unless `acknowledged === true` (gate 2);
   - validate format (`^sk-ant-oat`), reject otherwise;
   - ensure the per-member OneCLI agent (for tool secrets — same as today);
   - encrypt token → `oauth_token_enc`; `upsertByokCredential(cred_type:'oauth_token')`;
   - **never log the token.**

### Spawn (`container-runner.ts`, BYOK session)
For the resolved per-member session, look up the credential:
- `api_key` → today's path (OneCLI injects `x-api-key`).
- `oauth_token` → decrypt; `args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=' + token)`
  and `args.push('-e', 'NO_PROXY=api.anthropic.com')` (merge with any existing
  `NO_PROXY`). OneCLI still applied for tools.

### Revoke
Delete the encrypted blob + mark revoked; remove the user key from the
per-member agent (tools left), same as API-key revoke.

## 7. Touch points (all on `feat/byok-per-member`, additive)

- `src/db/migrations/0NN-byok-oauth.ts` — new columns.
- `src/modules/byok/db.ts` — `cred_type` + encrypted-blob get/set; a
  `getMemberCredential()` that returns a tagged union `{type, …}`.
- `src/modules/byok/crypto.ts` (**new**) — AES-256-GCM encrypt/decrypt + key
  bootstrap. ~40 lines, unit-tested with a fixed key.
- `src/modules/byok/onboard.ts` — branch on `type`; OAuth path skips
  `createAnthropicSecret`, stores the blob.
- `src/container-runner.ts` — BYOK spawn branch: env injection + `NO_PROXY` for
  oauth members (the agent-identity resolver already exists).
- `src/channels/webchat/migration.ts` + `db.ts` — `oauth_allowed` column +
  get/set; the credential endpoint accepts `{type, acknowledged}`; new
  `GET/PUT /api/rooms/:id/oauth-allowed` (owner/admin) for the room toggle.
- `public/webchat/{app.js,index.html}` — room-settings OAuth toggle (admin);
  second connect mode + `setup-token` instructions + acknowledgment checkbox,
  shown only when the room has `oauth_allowed`.

No agent-runner change → **no container rebuild**. No new npm deps (crypto is
Node built-in).

## 8. Risks / open questions (validate during build)

1. **`CLAUDE_CODE_OAUTH_TOKEN` + `NO_PROXY` interplay** — ✅ **VALIDATED**
   (2026-06-12, against the live agent image). Ran the real SDK in the container
   with a logging HTTPS_PROXY + an invalid `sk-ant-oat` token. Control (no
   NO_PROXY): the proxy logged `CONNECT api.anthropic.com:443` (proxy in-path).
   Test (`NO_PROXY=api.anthropic.com`): the proxy saw **zero** anthropic CONNECTs
   (only datadog telemetry — OneCLI still proxies everything else), and the
   request reached **real** Anthropic, returning `401 Invalid bearer token` /
   `authentication_failed` — i.e. OAuth Bearer mode engaged and the carve-out
   works. **Confirmed with a real subscription token** the same day: same env
   shape → clean completion (`result: "pong"`, `is_error=false`, no retries).
   The subscription path is validated end-to-end.
2. **Token longevity / expiry UX** — when a `setup-token` expires the member
   gets 401s; surface a clear "reconnect your subscription" banner rather than a
   silent failure.
3. **Host-can-decrypt** — accepted and documented. Mitigations: `0600` keyfile,
   token never logged, encrypted at rest. A motivated host operator can read
   them — but the host already runs every container, so this is not a new trust
   boundary, only a new at-rest artifact.
4. **In-container exposure** — the member's own agent can read its own
   `CLAUDE_CODE_OAUTH_TOKEN`. Identical to Claude Code on a personal machine;
   isolated per member. Prompt-injection in that member's content could exfil
   *that member's own* token — same baseline risk as any personal Claude Code
   use; never reaches another member.
5. **ToS drift** — if Anthropic later restricts headless subscription use, this
   feature is the first thing to disable. Keep it a distinct, opt-in credential
   type so it can be turned off without touching API-key BYOK.

## 9. Test plan

- Unit: crypto round-trip; `db.ts` tagged-union get/set; onboard OAuth branch
  (fake admin) stores blob + no Anthropic secret; revoke clears blob.
- Spawn: BYOK oauth session → container args contain `CLAUDE_CODE_OAUTH_TOKEN`
  and `NO_PROXY=api.anthropic.com`; api_key session unchanged.
- Live: real `setup-token` → one message round-trips on the subscription;
  `onecli` shows no Anthropic secret for that member's agent but tools still
  resolve; revoke → 401/declined.
- Regression: API-key BYOK and non-BYOK rooms untouched.

## 10. Recommendation

Build it as an **additive credential type** on `feat/byok-per-member`, behind the
own-use acknowledgment, with the host-side encrypted store as the explicit cost
of subscription support. Ship API-key and OAuth side by side; rooms/members
choose per connection.
