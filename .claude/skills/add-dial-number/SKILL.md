---
name: add-dial-number
description: Add another phone number to an existing Dial channel — a second (or third) public line for the agent, so one NanoClaw install answers SMS and AI voice calls on multiple numbers. Use when Dial is already installed and the operator wants an additional number (e.g. a personal line plus a support line). Requires the Dial channel to already be installed (see /add-dial).
---

# Add another Dial number

One NanoClaw install can serve **multiple Dial numbers** at once. Each number is
its own **public, threaded line** — its own messaging group (`platform_id` = the
Dial number), each remote correspondent a thread inside it — and the agent
replies from whichever number a person texted. Use this to run, say, a personal
line and a support line side by side, pointed at the same agent or at different
agents.

This skill is for adding a number to an **already-installed** Dial channel. If
Dial isn't installed yet, run `/add-dial` first.

## Prerequisites

### Dial is already installed

Confirm the channel exists (otherwise use `/add-dial`):

```bash
ls src/channels/dial.ts && grep -q "import './dial.js';" src/channels/index.ts && echo "Dial installed"
```

### The multi-number adapter

Adding a second number only works if the installed adapter routes on the number
each event arrived on (`data.to`) rather than a single hardcoded number. Check:

```bash
grep -q "eventLine" src/channels/dial.ts && echo "multi-number adapter OK" || echo "OLD single-number adapter — refresh first"
```

If it reports OLD, refresh the adapter before continuing (`/update-skills`, or
re-copy from the `channels` branch and rebuild):

```bash
git fetch origin channels
git show origin/channels:src/channels/dial.ts > src/channels/dial.ts
git show origin/channels:src/channels/dial-user-agent.ts > src/channels/dial-user-agent.ts
pnpm run build
```

`dial.ts` imports `dial-user-agent.js`, so refresh the two together — pulling the
adapter alone leaves a dangling import and the build fails.

A stale single-number adapter will misfile the new number's messages into the
first line and reply from the wrong number.

## Steps

### 1. Get the number (Dial side)

Reuse a number already on the account, or buy a new US number:

```bash
dial number list --json                                  # numbers already on the account
dial number purchase \
  --inbound-instruction "You are the support line for …" \
  --explicit-programmatic-consent "<account-holder consent attestation>"
```

`--inbound-instruction` is the system prompt Dial's AI receptionist uses for
voice calls to *this* number; change it later with
`dial number set <number> --inbound-instruction "…"`.

Pick the number you want to add and note its E.164 (e.g. `+14155550123`).

### 2. Choose the agent group

List agent groups and decide which one answers this number — the same one as
your first line, or a different one for a separate persona:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT id, name FROM agent_groups"
```

### 3. Wire it as a public line

Host service must be running (`ncl` is socket-only). No pairing is needed — the
install already has an owner.

Decide who may text THIS number before you run the command: `public` for a line
strangers can start conversations on, `strict` to admit only the owner and anyone
you add as a member. It's a per-line choice — this number's answer is independent
of your first line's, so a public support line can sit next to a private personal
one:

```bash
ncl messaging-groups create --channel-type dial --platform-id "+1NEWNUMBER" --is-group 1 --name "<label>" --unknown-sender-policy public
ncl wirings create --messaging-group-id <new-mg-id> --agent-group-id <ag-id>
```

Pass `--unknown-sender-policy` explicitly. The adapter declares `strict` for
creation, so omitting the flag gives you an owner-only line that silently refuses
strangers — not what you want for a public number. `--is-group 1` is what makes
each texter their own thread instead of collapsing everyone into one session;
`threads` comes from the adapter declaration. (`/manage-channels` walks the same
two commands if you'd rather be guided.)

### 4. Restart and verify

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)   # macOS
# systemctl --user restart $(systemd_unit)             # Linux
```

Confirm both lines are wired:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT platform_id, unknown_sender_policy FROM messaging_groups WHERE channel_type='dial'"
```

Then text or call the new number — it reaches the agent as a **separate** line,
and replies go out from that number. Your existing line is unaffected.

## Troubleshooting

- **New number's texts land in the old line's conversation, or replies come from
  the wrong number** → the adapter is the old single-number version; refresh it
  (Prerequisites above) and restart.
- **New number never delivers inbound** → the `dial listen` daemon fans out
  events for the whole account, so one daemon covers all numbers; confirm it's
  running (`dial doctor --json` → `listen.running: true`) and that the command
  target is registered (`dial local-target list --json`).
- **`ncl` errors** → the host service must be running; `ncl` connects over a Unix
  socket.
