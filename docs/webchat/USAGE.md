# Webchat — User Guide

How to use the built-in web chat once it's enabled. For enabling, env vars,
deploy, and architecture, see [README.md](README.md).

## Opening it

Open **http://127.0.0.1:3100/** (or your configured `WEBCHAT_PORT`) in a
browser.

- **Localhost, no token** (the default): you're signed in automatically as the
  owner — loopback is trusted.
- **Token set** (`WEBCHAT_TOKEN` in `.env`, or after the access step below):
  a login screen asks for the token. Paste it; it's stored in the browser and
  the first identity to log in becomes the owner.

It's a PWA — on a phone, "Add to Home Screen" installs it as an app. After a
new deploy the page reloads itself once when the updated version is served, so
you don't need to hard-refresh.

## First run: the wizard

On a fresh install (no agents, no rooms) a short wizard opens automatically.
You can also open it any time from **⚙ → Run setup wizard…**. Three steps,
all skippable:

1. **Which model powers your agents?** — an accordion with two cards:
   - **Claude (Anthropic)** — expands a credentials row. If a Claude
     credential is already in your OneCLI vault it shows "✓ connected";
     otherwise **Connect** runs a browser sign-in (open the link, paste the
     code back) and stores the token in the vault.
   - **Local model (Ollama)** — expands an endpoint box (prefilled
     `http://127.0.0.1:11434`) and a **Probe**. Probe reports what it found
     ("Ollama detected — N models"), lists the models as radios (picking one
     makes it the default), and offers a **Pull** box to download a new model
     with live progress. If Ollama isn't running locally, an **Install Ollama
     on this machine** button appears (Linux only); install failures are shown
     inline.
2. **Reach it from other devices?** (optional) — see [Access](#access) below.
3. **Create your first agent** — a name and optional instructions. **✨ Draft
   from an idea** turns a one-line description into a name + instructions.
   **Create & finish** makes the agent and a room wired to it. (On a re-run
   with agents already present, this becomes "Add another agent" and an empty
   name just finishes.)

## The chat

- **Rooms** are listed on the left, most-recent first, with an unread dot.
  Click one to open it. One agent answers each room.
- **Send** a message with Enter (Shift+Enter for a newline). Your message
  appears immediately; if the socket is reconnecting, sending is blocked with a
  toast rather than silently dropped.
- **Attachments**: the 📎 button. Files up to 25 MB inline directly; larger
  files are staged for the agent to read. The agent can also send you files
  back.
- **Slash commands** (type `/` in the composer): `/clear`, `/compact`,
  `/context`, `/cost`, `/files`.
- **Thinking bubble**: while an agent works, a live bubble shows its tool
  activity and streaming reasoning, with a per-agent **Stop** to interrupt the
  turn. It closes when the turn finishes (or if the container dies mid-turn).
- **Approvals**: when an agent needs sign-off (e.g. installing a package), the
  request appears as an actionable card in the room, and the owner also gets it
  in an inbox toast — Approve/Reject right there.

### Managing rooms

- **Create**: the **+** button (top-left) — name it and pick the agent.
- **Rename**: click the room title in the header, type, Enter to save.
- **Delete**: the 🗑 button in the room header (confirm-gated). Messages are
  removed; the room's wiring is torn down.

## The management drawer (⚙)

Two tabs.

### Agents

- **New agent**: a name + optional instructions, or **✨ Suggest from prompt**
  (the LLM drafter) to generate both from an idea, then **Create agent**.
- Each agent row has:
  - a **model picker** — "Install default (…)" follows the install-wide
    default, or pick a specific registered model (takes effect next turn);
  - **Instructions** — expands an editor for the agent's standing instructions
    (its `CLAUDE.md` persona). Save applies on the agent's next session;
  - **Delete** — removes the agent (its rooms stay but stop routing to it).

### Models

Top-to-bottom:

- **Your models** — the roster. Each row has a live status dot: green =
  reachable from agent containers, red = unreachable (tap the dot to see why),
  grey = cloud/Anthropic. Star one as the **default**; ✕ removes it.
  An empty roster shows "Claude — built-in default": agents fall back to the
  provider's built-in Claude model until you register one.
- **On this machine** — the local Ollama console: your host's models with
  sizes, an **Add to roster** shortcut per model, a **Pull** box with streamed
  progress and cancel, and (when local Ollama is down) a one-click installer.
- **Add custom endpoint** — a two-pass probe: type any endpoint (prefilled
  localhost), **Probe** detects what's serving (Ollama, or OpenAI-compatible
  like LiteLLM / vLLM), then lists its models with one-click **Add**. Bare
  hostnames are normalized (`localhost` → `http://localhost:11434`).

Assigning an Ollama-kind model to an agent automatically switches that agent's
harness to the in-tree OpenCode provider; Claude-family models use the default
harness.

## Access

By default the chat is **localhost-only** — reachable only from the machine
it runs on. To reach it from your phone or another device, open **⚙ → Run
setup wizard… → the access step**, which offers:

- **Tailscale HTTPS** — puts the chat on your tailnet with a real cert (so the
  PWA installs cleanly on a phone). One click if Tailscale is up.
- **Access token** — generates a bearer token and opens the port to your
  network (binds `0.0.0.0`). The token is shown once with a **Copy** button;
  save it — you log in with it, and it takes effect after the restart at the
  end of the wizard. Generation is two-click confirmed, since it changes your
  network exposure.

To return to localhost-only later: remove `WEBCHAT_TOKEN` from `.env`, set
`WEBCHAT_HOST=127.0.0.1`, and restart.

## Beyond the UI

Everything the drawer doesn't cover — wirings, roles, scheduled tasks,
cross-agent messaging — is managed with the `ncl` CLI. See the main
[CLAUDE.md](../../CLAUDE.md) for the `ncl` reference.
