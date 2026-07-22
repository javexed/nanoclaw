# Webchat text-to-speech (design + integration map)

Status: **v1 scope.** A read-aloud control on agent messages in the webchat
PWA, backed by a local Kokoro-FastAPI container, with a Web Speech API fallback
when no backend is configured. Speech only (TTS); voice *input* (STT) is out of
scope.

## Goal

Let the webchat assistant speak its replies, naturally, without a cloud
dependency or a recurring bill:

```
browser (PWA)  ──POST /api/tts──►  webchat host  ──POST /v1/audio/speech──►  Kokoro-FastAPI
  play button      (same-origin)     (Node)          (127.0.0.1:8880)          (Kokoro-82M, CPU)
      ▲                                  │
      └──────────── audio/mpeg ◄─────────┘
```

The browser never talks to the backend directly — it POSTs message text to the
**webchat origin**, which proxies to the backend and streams audio back. That
indirection is the whole reason this works over Tailscale/remote access: the
client only needs to reach webchat, and the backend stays loopback-bound.

## Why Kokoro

- **Open-weight, Apache-2.0** — genuinely permissive, commercial-OK.
- **82M params, ~330MB** — runs **faster-than-real-time on CPU**; a GPU is
  optional, not required.
- **Quality/size ratio** — ranks near paid services despite its size.
- **OpenAI-compatible** via [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI)
  (`POST /v1/audio/speech`), so the host route is a thin proxy that also works
  unchanged against OpenAI's TTS or any compatible server if the operator
  prefers — just re-point `WEBCHAT_TTS_ENDPOINT`.
- **Zero recurring cost, fully private** — audio never leaves the machine.

The alternative considered was **OpenAI TTS** (`gpt-4o-mini-tts`): easier (no
container) and very natural, but usage-billed and cloud-dependent. The route
supports it (same endpoint contract) for operators who want it; Kokoro is the
default because it fits NanoClaw's local-first, no-key ethos.

## Where it hooks in

Three surfaces, each a small, self-contained touch. All are **inert unless
`WEBCHAT_TTS_ENABLED=true`**, so the feature ships dark and the `/add-webchat-tts`
skill turns it on.

| Surface | File | What |
|---------|------|------|
| Host route | `src/channels/webchat/tts.ts` (new) | `GET /api/tts/config` (capability probe) + `POST /api/tts` (synthesis proxy). Owns its own enabled-gating, input caps, timeout, and backend call. |
| Route wiring | `src/channels/webchat/server.ts` | One import + one guarded call (`if (await maybeHandleTts(...)) return;`) placed **after the auth gate** — synthesis is authenticated like every `/api/*` route. Plus one CSP token: `media-src 'self' blob:` (blob audio playback). |
| Config surface | `src/channels/webchat/env-load.ts` | Four `WEBCHAT_TTS_*` keys added to the preload allowlist so a service-managed host reads them from `.env`. |
| PWA control | `public/webchat/app.js` | `loadTtsConfig()` at post-auth boot; `buildTtsButton()` on agent bubbles in `appendMessage()`; `speak()` handles server-fetch → blob → `Audio`, with a Web Speech API fallback. `ttsPlainText()` strips markdown so the voice reads prose. |
| Icon + style | `public/webchat/index.html`, `style.css` | `i-volume-2` / `i-square` sprite symbols; `.tts-btn` / `.msg-actions` (hover-revealed icon button, token-based, `lightbox-spin` for the synth wait). |
| Backend | `.claude/skills/add-webchat-tts/` | Idempotent installer stands up `nanoclaw-kokoro-tts` (loopback-only), health-checks it, writes the `.env` flags. |

### The two routes

- `GET /api/tts/config` → `{ enabled, voice }`. The PWA calls this once at boot.
  `enabled:false` → the control uses Web Speech; `true` → it uses the server.
- `POST /api/tts` `{ text, voice? }` → `audio/mpeg`. Trims + caps input
  (4000 chars), forwards an OpenAI-shaped body to the backend, buffers the
  result (replies are short — sub-megabyte) and returns it. `503` when disabled,
  `502` on backend error, `504` on timeout (30s, generous for cold model load).

### Playback + CSP

The PWA fetches audio via `authFetch` (same-origin, so `connect-src 'self'`
covers it), wraps it in a `blob:` URL, and plays it with `Audio`. `<audio>` src
is governed by `media-src`, which falls back to `default-src 'self'` — so blob
playback needs `media-src 'self' blob:` in the CSP (mirroring the existing
`img-src … blob:` carve-out). That one token is the only CSP change.

## Degradation ladder

1. **Backend up + flag on** → server synthesis (Kokoro voices).
2. **Flag on but backend unreachable** → `POST /api/tts` returns 5xx; the PWA
   catches it and falls through to Web Speech (device voices) for that click.
3. **Flag off** → `/api/tts/config` says `enabled:false`; the PWA uses Web
   Speech from the start.
4. **No Web Speech either** (rare) → the control is omitted; a click (if any)
   toasts "Audio playback failed".

So the read-aloud control is always either functional or absent — never a dead
button.

## Trust boundary

The Kokoro port binds **`127.0.0.1` only** and takes **no credential**, so there
is no secret to leak and nothing to authenticate at the backend. The webchat
host is the sole caller. `/api/tts` sits behind webchat's auth gate, so remote
access inherits the same login as the rest of the app. Rebinding the Kokoro
port beyond loopback would turn it into an open synthesis service — don't.

## Testing

`src/channels/webchat/tts.test.ts` covers the route logic: the config probe
(enabled/disabled + voice), disabled-synthesis rejection, empty-input
rejection, the backend proxy shape (OpenAI-compatible body, `audio/mpeg` out),
and backend-error → 502. The PWA control has no in-tree test harness (no DOM
runner for the webchat PWA); it's feature-flagged and degrades safely, and the
route it depends on is covered.

## Not in scope (v1)

- **Speech-to-text / voice input** — a separate feature (mic capture + an STT
  backend).
- **Auto-speak** (speak every reply without a click) — easy to layer as a
  Settings toggle over `speak()`; deliberately omitted to keep v1 opt-in per
  message.
- **Per-room / per-agent voices** — the default voice is install-wide
  (`WEBCHAT_TTS_VOICE`); the route already accepts a per-request `voice`, so a
  future UI can pass one without a backend change.
