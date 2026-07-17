---
name: add-webchat-dictation
description: Add voice dictation to the webchat PWA — a mic button in the composer that transcribes speech into the message box. Local whisper.cpp backend (recommended, no cloud, no API key) or ElevenLabs cloud STT as an explicit opt-in; optional transcript-cleanup pass via a roster model. Use when the user wants to dictate webchat messages by voice.
---

# Add webchat voice dictation

Gives the webchat PWA a **mic button in the composer**: tap, speak, and the
transcript lands in the message box — sending stays your explicit act. Two
backends behind one seam:

- **Local (recommended, default):** a pinned [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
  `whisper-server` container with a pinned ggml Whisper model — no cloud, no API
  key, no per-use cost, audio never leaves the machine. Model size is
  **hardware-suggested** (same rules as the Ollama install): GPU or a big box →
  `small`, mid → `base`, small → `tiny`; `.en` variants are the speed option.
- **Cloud (explicit opt-in):** ElevenLabs speech-to-text (`scribe_v1`). No
  container or download — just an API key. **Audio is sent to ElevenLabs**; the
  Settings UI says so before you pick it.

An optional second pass tidies the raw transcript (punctuation, fillers,
casing) with a separate roster model — every failure falls back to the raw
text. The webchat host **proxies** everything (`/api/stt/*` → backend), so the
browser only ever talks to the webchat origin and dictation works over
Tailscale/remote access.

## Prerequisites

1. **The webchat channel installed** (this repo's `channels-webchat`). The host
   routes (`src/channels/webchat/stt.ts`) and the PWA mic ship with it; this
   skill provisions the backend and flips the flag.
2. **Docker** on the host — for the local backend only. Not needed for
   ElevenLabs or an external `--url` endpoint.

## Install

The normal path is **Settings → Features → Voice dictation** (owner-only):
pick Local or ElevenLabs, keep or change the suggested model, hit Install /
Connect. The server runs this same installer and activates the `.env` keys
in-process — no restart.

From a shell instead:

```bash
# Local backend, hardware-suggested model:
bash .claude/skills/add-webchat-dictation/resources/install-whisper.sh

# Pick the model / port / language explicitly:
bash .claude/skills/add-webchat-dictation/resources/install-whisper.sh --model small --port 8771 --lang auto

# No container — point at an existing whisper.cpp / OpenAI-compatible server (e.g. the GPU box):
bash .claude/skills/add-webchat-dictation/resources/install-whisper.sh --url http://gpu-box:8000/v1 --model whisper-1
```

Shell installs need one host restart afterwards (the Settings flow doesn't).

Installing turns dictation **on for everyone** in the workspace (writes
`WEBCHAT_STT_ENABLED=true`); the mic then appears in every member's composer.
Owners can toggle it off later from Settings → Features → Voice dictation.

ElevenLabs has no script path — configure it from Settings, which validates the
key against the ElevenLabs API and writes `WEBCHAT_STT_PROVIDER=elevenlabs` +
`WEBCHAT_STT_API_KEY` to `.env`.

## What it writes

| Key | Meaning |
|---|---|
| `WEBCHAT_STT_ENABLED` | `true` turns the feature on (mic appears) |
| `WEBCHAT_STT_PROVIDER` | `local` \| `openai-compat` \| `elevenlabs` |
| `WEBCHAT_STT_URL` | backend base URL (loopback for local) |
| `WEBCHAT_STT_MODEL` | ggml model name / provider model id |
| `WEBCHAT_STT_LANG` | language code, `auto` = detect |
| `WEBCHAT_STT_API_KEY` | cloud only — never sent to the browser |

The cleanup model is *not* env — it's the `stt_cleanup_model_id` column on
`webchat_settings`, set from the same Features block.

## Verify

```bash
docker logs nanoclaw-whisper-stt                    # local backend logs
curl -fsS http://127.0.0.1:8771/inference \
  -F "file=@.claude/skills/add-webchat-dictation/resources/fixture.wav" \
  -F response_format=text -F no_timestamps=true     # → "NanoClaw dictation test, one two three."
```

Then reload the PWA — the mic appears next to the composer's attach button.
