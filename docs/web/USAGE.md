# Web UI — User Guide

How to use the web UI once it's enabled. For enabling, env vars, deploy and
architecture, see [README.md](README.md).

## Opening it

Open **http://127.0.0.1:3100/** (or your configured `WEB_PORT`) in a browser.
If you enabled the web UI during setup, it offered to open this for you at the
end; on a headless machine it printed the URL instead.

- **Localhost, no token** (the default): you are signed in automatically as
  the owner — loopback is trusted.
- **Token set** (`WEB_TOKEN` in `.env`, or after the access step below): a
  login screen asks for the token. Paste it; it is stored in the browser, and
  the first identity to log in becomes the owner.

It is a PWA — on a phone, "Add to Home Screen" installs it as an app. After a
deploy the page reloads itself once when the new version is served, so you
never need to hard-refresh.

## First run: the wizard

On a fresh install (no agents, no rooms) a short wizard opens by itself —
this is where setup hands off when you enabled the web UI in the terminal.
You can reopen it any time from **⚙ → Setup…**. Every step is skippable.

**1. Model** — two cards:

- **Claude** — a credentials row. If a Claude credential is already in your
  OneCLI vault it shows "Connected"; otherwise **Connect** runs a browser
  sign-in (open the link, paste the code back) and stores the token in the
  vault.
- **Local (Ollama)** — an endpoint box (prefilled `http://127.0.0.1:11434`)
  and **Probe**. Probe reports what it found ("Ollama — N models") and lists
  them as radios; picking one makes it the default. **Pull** downloads a new
  model with live progress. If Ollama isn't running locally, **Install
  Ollama** appears (Linux only); install failures show inline.

**2. Access** (optional) — see [Access](#access).

**3. First agent** — a name and optional instructions. **✨ Draft** turns a
one-line idea into both. **Create** makes the agent and a room wired to it. On
a re-run with agents already present the step is "Another agent", and
**Finish** with an empty name just finishes.

## The chat

- **Rooms** are listed on the left, most-recent first, with an unread dot.
  Click one to open it. One agent answers each room.
- **Send** with Enter (Shift+Enter for a newline). Your message appears
  immediately; if the socket is reconnecting, sending is blocked with a toast
  rather than silently dropped.
- **Attachments** — the 📎 button. Files up to 25MB inline directly; larger
  ones are staged on disk for the agent to read. The agent can send files back
  the same way.
- **Slash commands** (type `/` in the composer): `/clear`, `/compact`,
  `/context`, `/cost`, `/files`.
- **Thinking bubble** — while an agent works, a live bubble shows its tool
  activity and streaming reasoning, with a per-agent **Stop** to interrupt the
  turn. It closes when the turn ends, or if the container dies mid-turn.
- **Learning** — type `/learn` and the agent reviews the conversation for a
  reusable lesson; if it finds one, a card appears in the room with the
  proposed skill. **View** shows the full text, **Keep** wires it to that
  agent (it restarts to pick it up), **Discard** drops it. If a similar skill
  already exists, Keep asks first. Words after `/learn` steer the review.
  With **Auto-learn** on for an agent (⚙ → Agents), the review also runs by
  itself after a busy turn — you only hear about it when there is a card.
- **Approvals** — when an agent needs sign-off (installing a package, say) the
  request appears as an actionable card in the room, and the owner also gets
  it as an inbox toast. Approve or reject from either.

### Managing rooms

- **Create** — the **+** button (top-left): name it and pick the agent.
- **Rename** — click the room title in the header, type, Enter to save.
- **Delete** — the 🗑 button in the room header, confirm-gated. Messages go
  and the room's wiring is torn down.

## The management drawer (⚙)

Two tabs.

### Agents

- **New agent** — a name and optional instructions, or **✨ Suggest from
  prompt** to generate both from an idea, then **Create agent**.
- Each agent row carries:
  - a **model picker** — "Install default (…)" follows the install-wide
    default, or pick a specific registered model. Takes effect next turn.
  - **Instructions** — an editor for the agent's standing instructions (its
    `CLAUDE.md` persona). Saving applies on the agent's next session.
  - **Delete** — removes the agent. Its rooms stay but stop routing to it.
  - **Auto-learn** Off/On — busy turns run a skill review by themselves.
    Only ever stages a draft for the card; takes effect on the agent's next start.

### Models

- **Your models** — the roster. Each row has a live status dot: green means
  reachable from agent containers, red means unreachable (tap it for the
  reason), grey means cloud/Anthropic. Star one as the default; ✕ removes it.
  An empty roster shows "Claude": agents fall back to the
  provider's built-in Claude model until you register something.
- **On this machine** — the local Ollama console: your host's models with
  sizes, an **Add** shortcut per model, a **Pull** box with streamed
  progress and cancel, and a one-click installer when local Ollama is down.
- **Add custom endpoint** — a two-pass probe. Type any endpoint (prefilled
  localhost) and **Probe** detects what is serving it — Ollama, or something
  OpenAI-compatible like LiteLLM or vLLM — then lists its models with
  one-click **Add**. Bare hostnames are normalised (`localhost` →
  `http://localhost:11434`).

Assigning a model changes which model the agent talks to. Local models —
Ollama and OpenAI-compatible endpoints — run on OpenCode, which is installed on
demand; until it is, a local assignment has no harness to run on. See
[local models](README.md#local-models).

## Access

By default the chat is **localhost-only** — reachable only from the machine it
runs on. To reach it from a phone or another device, open **⚙ → Run setup
wizard… → the access step**:

- **Tailscale HTTPS** — puts the chat on your tailnet with a real certificate,
  so the PWA installs cleanly on a phone. One click if Tailscale is up.
- **Access token** — generates a bearer token and opens the port to your
  network (binds `0.0.0.0`). The token is shown once with a **Copy** button —
  save it, you log in with it. It takes effect after the restart at the end of
  the wizard. Generation is two-click confirmed, because it changes your
  network exposure.

To go back to localhost-only: remove `WEB_TOKEN` from `.env`, set
`WEB_HOST=127.0.0.1`, and restart.

## Beyond the UI

The drawer covers agents and models. Everything else — wirings, roles,
scheduled tasks, cross-agent messaging — is the `ncl` CLI; see
[CLAUDE.md](../../CLAUDE.md) for its reference.
