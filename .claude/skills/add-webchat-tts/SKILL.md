---
name: add-webchat-tts
description: Add natural text-to-speech to the webchat PWA — a "read aloud" control on agent messages, backed by a local Kokoro-FastAPI container (Apache-2.0, no cloud, no API key, no per-use cost). Falls back to the browser's Web Speech API when the backend is off. Use when the user wants the webchat assistant to speak its replies.
---

# Add webchat text-to-speech (Kokoro)

Gives the webchat PWA a **read-aloud control** on every agent reply. Two
backends, one affordance:

- **Server-side (recommended):** a local [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI)
  container — Kokoro-82M is an open-weight (**Apache-2.0**) model that sounds
  close to paid services, runs **faster-than-real-time on CPU**, needs **no API
  key, no cloud, no per-use cost**, and keeps audio fully on-device.
- **Fallback:** if the backend is off, the PWA uses the browser's built-in
  **Web Speech API** (device voices) — the control still works, just with
  whatever voices the client OS provides.

The webchat host **proxies** synthesis (`/api/tts` → backend) so the browser
only ever talks to the webchat origin. That's what makes it work over
Tailscale/remote access, not just localhost.

Design + integration map: [docs/webchat/design/add-webchat-tts.md](../../../docs/webchat/design/add-webchat-tts.md).

## Prerequisites

1. **The webchat channel installed** (this repo's `channels-webchat`). The
   host route (`src/channels/webchat/tts.ts`) and the PWA control ship with it;
   this skill provisions the backend and flips the flag.
2. **Docker** on the host (for the Kokoro backend). Not needed if you only want
   the Web Speech fallback — see "Fallback only" below.

## Install

```bash
bash "${CLAUDE_SKILL_DIR}/resources/install-kokoro.sh" \
  [--voice af_heart] [--port 8880] [--gpu] [--tag <image-tag>] [--dry-run]
```

Idempotent — re-run to change the voice, port, or image tag. What it does:

1. **Runs** `ghcr.io/remsky/kokoro-fastapi-cpu` (or `-gpu` with `--gpu`) at a
   pinned tag, bound to **`127.0.0.1:<port>` only** (never `0.0.0.0` — an open
   port would be a free, unauthenticated synthesis service). Container name:
   `nanoclaw-kokoro-tts`.
2. **Health-checks** the backend (`/health`, then `/v1/audio/voices`). First
   boot downloads the model (~330MB) and can take a minute or two — a slow
   first start is normal.
3. **Writes** `WEBCHAT_TTS_*` to `.env` (idempotent; `--no-env` to skip):
   `WEBCHAT_TTS_ENABLED=true`, `WEBCHAT_TTS_ENDPOINT`, `WEBCHAT_TTS_MODEL=kokoro`,
   `WEBCHAT_TTS_VOICE`.

Then **restart the webchat host** so it reads the new `.env`, and reload the PWA:

```bash
systemctl --user restart nanoclaw                    # Linux
launchctl kickstart -k gui/$(id -u)/com.nanoclaw     # macOS
```

## Verify

```bash
# Backend answers and can synthesize:
curl -s http://127.0.0.1:8880/v1/audio/voices | head -c 300
curl -s http://127.0.0.1:8880/v1/audio/speech -H 'Content-Type: application/json' \
  -d '{"model":"kokoro","voice":"af_heart","input":"Hello from Kokoro.","response_format":"mp3"}' \
  --output /tmp/tts-test.mp3 && echo "wrote /tmp/tts-test.mp3"

# Host proxy reports enabled (needs a webchat auth session; localhost is open):
curl -s http://127.0.0.1:3100/api/tts/config
```

In the PWA, an **owner** must first turn the feature on for the workspace:
Settings → Features → Read aloud → **On** (it is off by default — a single
workspace-wide switch, not per device). Then open a room, get an agent reply,
hover it — a speaker icon appears in the bubble's bottom-left corner; click to
hear it, click again to stop. Until an owner flips that switch, no control
appears for anyone — that is expected, not a broken install.

## Choosing a voice

List what the backend serves: `curl -s http://127.0.0.1:8880/v1/audio/voices`.
Kokoro voice ids encode language + gender, e.g. `af_heart`, `af_bella`,
`am_adam` (American f/m), `bf_emma`, `bm_george` (British). Change the default
with `--voice <id>` (re-run) — it lands in `WEBCHAT_TTS_VOICE`; restart the host
to apply.

## Fallback only (no backend)

Skip the container entirely — leave `WEBCHAT_TTS_ENABLED` unset and, once an
owner turns on Read aloud (Settings → Features), the PWA uses the browser's Web
Speech API automatically. Zero infra, zero cost; voice quality is whatever the
client device provides (good on Apple platforms, variable elsewhere). No backend
to install — but the workspace Read aloud switch still gates whether the control
shows at all.

## Operations

- **Change voice/port/tag** → re-run the installer, restart the host.
- **Logs**: `docker logs nanoclaw-kokoro-tts`.
- **Stop/remove backend**: see [REMOVE.md](REMOVE.md).
- **Tests**: the host route is covered by `src/channels/webchat/tts.test.ts`
  (`pnpm exec vitest run src/channels/webchat/tts.test.ts`).

## Trust boundary

The backend binds loopback-only and takes no key, so there's no secret to leak
and no port to expose. The webchat host is the only caller. If you ever front
webchat with a reverse proxy, `/api/tts` is authenticated like every other
`/api/*` route — synthesis is gated behind the same login. Never rebind the
Kokoro port beyond `127.0.0.1`.
