# Approval pre-judge (optional LLM triage)

An optional tier in front of human approvals: a roster model (webchat_models)
looks at an approval hold before any human sees it and answers one question —
*is this specific request routine, low-stakes, and easily reversible?* On a
clean `approve` verdict the approval is resolved through the **exact same
dispatch path a human Approve click takes**; on anything else the card is
delivered to approvers exactly as today. Its purpose is reducing approval
fatigue for low-stakes holds — humans keep everything else.

Two judge shapes are accepted:

- **Local** — an `ollama` / `openai-compatible` roster model with an endpoint
  (LiteLLM/Ollama), called at `<endpoint>/v1/chat/completions`.
- **Claude** — an `anthropic`-kind roster model (endpoint NULL, `model_id` a
  Claude model such as `claude-haiku-4-5`). The consult is an Anthropic
  Messages call routed through the **OneCLI gateway** — the exact credentialed
  path the webchat drafter uses (`anthropicMessagesViaOneCLI` in
  `src/channels/webchat/drafter.ts`, sharing its `webchat-drafter` OneCLI
  identity) — so the host never holds a raw Anthropic key. This makes the
  pre-judge usable on Claude-only installs with no local models: appoint e.g.
  Haiku as the judge.

Code: `src/modules/approvals/prejudge.ts` (rubric text lives there as
`PREJUDGE_RUBRIC`). Hook point: `requestApproval` in
`src/modules/approvals/primitive.ts`, immediately after the pending row is
written and before any card is surfaced.

## Defaults — OFF twice over

- `approvalPrejudgeModelId` is NULL: no model, nothing is ever consulted.
- `approvalPrejudgeActions` is empty: even with a model set, **no action is
  pre-judged until it is explicitly opted in**.

Both live as columns on the `webchat_settings` singleton
(`approval_prejudge_model_id`, `approval_prejudge_actions`; migration 207).

## Fail-safe contract

There is **no auto-deny** — the model can only `approve` or `escalate`; deny
stays human-only. Every failure mode escalates to a human: model absent or
wrong kind, endpoint down, timeout (10s), non-200, empty/unparseable output,
any verdict other than exactly `"approve"`, a targeted approval
(`approver_user_id` set), or a crash anywhere in the pre-judge itself.
Verdicts are per-request — nothing is cached.

## Never-list (hardcoded, overrides opt-in)

Actions that always reach a human, regardless of configuration:

| Entry | Why |
|-------|-----|
| `onecli_credential` | Credential use; also resolved via a separate in-memory path |
| `install_packages` | Supply chain — new code baked into the container image |
| `add_mcp_server` | New tool/capability surface for the agent |

Payload patterns (matched against the raw payload JSON of **any** action, so
e.g. a held `cli_command` can never be auto-approved when it touches these):

- `cli_scope` — container privilege level changes
- `roles grant` / `roles revoke` — user privilege changes
- `config update|add-mcp-server|remove-mcp-server|add-package|remove-package` — container config verbs

The PUT endpoint also refuses to opt in a never-listed action outright.

## Enabling it (owner-only)

**UI:** Settings → Approval pre-judge (owner-only). Pick a judge model
(Off = feature off), then switch on the actions to pre-judge; never-listed
actions render disabled.

**API:**

```bash
# Inspect current config + registered actions + the never-list
curl -s https://<host>/api/approvals/prejudge -H "Authorization: Bearer $TOKEN"

# Pick a roster model (webchat_models.id) and opt in an action
curl -s -X PUT https://<host>/api/approvals/prejudge \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "X-Requested-With: XMLHttpRequest" \
  -d '{"modelId":"<roster-model-id>","actions":["cli_command"]}'

# Turn it off again
curl -s -X PUT ... -d '{"modelId":null,"actions":[]}'
```

`GET /api/approvals/prejudge` — guard `owner`; the response includes
`knownActions` (every action with a registered approval handler). `PUT` —
guards `csrf, owner`. The PUT validates `modelId` with the same gate the
runtime uses (`isUsableJudgeModel`): an `anthropic`-kind roster model, or an
`ollama`/`openai-compatible` roster model with an endpoint.

## What the model sees

Action name, card title, the human-readable request text, and the payload
JSON truncated to 2000 chars — all passed through redaction first
(`redactSensitiveData` from `src/channels/webchat/redact.ts`, supplemented
with the agent-runner's bearer/OneCLI/MCP-relay token patterns). Local judges
are called through `safeFetch` (SSRF-guarded) with `temperature: 0`;
anthropic-kind judges go through the OneCLI proxy with a small `max_tokens`
and **no sampling params** (current Claude models reject non-default
`temperature` with a 400). Both paths share the 10s timeout and the strict
verdict parse.

## Audit trail

An auto-approve emits:

- a `log.info('Approval auto-approved (pre-judge)', { action, approvalId, model, reason })` line,
- a system message to the requesting agent's session: `Auto-approved (pre-judge): <reason>`,
- the normal approval-resolved callbacks (webchat cards, etc.) with resolver
  id `prejudge:<model-id>` — the same surfaces a human approval hits, since
  resolution goes through the shared dispatch (`resolveApprovalAsApproved` in
  `src/modules/approvals/response-handler.ts`).

Escalations after a consult are logged too (`Approval pre-judge escalated to
human`); feature-off and not-opted-in cases are silent no-ops.
