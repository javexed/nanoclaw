# Installing NanoClaw

Three ways in, depending on where you're starting. All land on the same thing: a
running NanoClaw with the webchat setup wizard at `http://<host>:3100` — open it,
and the browser walks you through Claude/Codex sign-in or a local model. No API
key on the command line, no `claude` login on the box.

## 1. Fresh Debian/Ubuntu host — one command

A VM, a Raspberry Pi, bare metal, or a container guest:

```bash
curl -fsSL https://raw.githubusercontent.com/javexed/nanoclaw/channels-webchat/deploy/install.sh | sudo bash
```

A few minutes later (it builds the agent image) it prints the webchat **URL +
bearer token**. Details, env overrides, and the update flow:
**[../../deploy/README.md](../../deploy/README.md)**.

## 2. Proxmox VE — LXC helper script _(in testing)_

A Proxmox VE Helper-Scripts (`ct/` + `install/`) entry, maintained at
**[javexed/ProxmoxVED](https://github.com/javexed/ProxmoxVED)**. It creates a
Debian 13 LXC and installs NanoClaw on the community `build.func` framework. Not
yet in the upstream community-scripts catalog — run it from the fork branch:

```bash
COMMUNITY_SCRIPTS_URL="https://raw.githubusercontent.com/javexed/ProxmoxVED/feat/nanoclaw" \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/javexed/ProxmoxVED/feat/nanoclaw/ct/nanoclaw.sh)"
```

The container runs Docker, so it's created with `nesting=1,keyctl=1`. First boot
builds the agent image — allow several minutes.

## 3. Add webchat to an existing NanoClaw fork

Already running NanoClaw (Node + pnpm) and just want the chat UI? Webchat is a
channel you add to your fork, not a separate install. From Claude Code:

```
/add-webchat
```

Or run `install-webchat.sh` from inside your fork. Full walkthrough:
**[readme.md](readme.md)** and **[guide.md](guide.md)**.

## What it needs

- **Debian or Ubuntu** (apt + systemd). Non-apt distros use path 3 on an existing
  install, or Docker Compose.
- **x86_64 with AVX2** preferred — the Claude Code CLI is a native x86 binary that
  hangs without it (on a Proxmox VM set the CPU type to `host`). **arm64**
  (Raspberry Pi) works for the Claude/API path; local models want an x86 box.
- **Docker** — each agent session runs in its own sandbox; the installers set it
  up for you.

Reach it over your LAN or [Tailscale](readme.md#authentication-at-a-glance); the
first Tailscale login becomes owner, after which you can enable HTTPS and retire
the bearer token from the wizard.
