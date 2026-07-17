#!/usr/bin/env bash
#
# install-kokoro.sh — idempotent installer for a local Kokoro-FastAPI TTS
# backend, wired to the webchat channel's /api/tts proxy (src/channels/webchat/
# tts.ts).
#
# One job: run a local-only Kokoro-FastAPI container that exposes an
# OpenAI-compatible speech endpoint (POST /v1/audio/speech), then point the
# webchat host at it via WEBCHAT_TTS_* in .env. No cloud, no API key, no
# per-use cost — Kokoro-82M is Apache-2.0 and runs faster-than-real-time on CPU.
#
# The endpoint binds to 127.0.0.1 only. The webchat host (a Node process on the
# same machine) reaches it at 127.0.0.1:<port>; nothing else can. Browsers never
# touch it directly — they POST message text to the webchat origin's /api/tts,
# which forwards here, so TTS works over Tailscale/remote access too.
#
# Flags / env:
#   --port <n>     host loopback port for the backend        (default 8880)
#   --voice <id>   default voice (af_heart, am_adam, bf_emma, …) (default af_heart)
#   --tag <t>      Kokoro-FastAPI image tag (KOKORO_TAG env)  (default: pinned below)
#   --gpu          use the CUDA image instead of the CPU image
#   --skip-run     write .env config only, don't (re)start the container
#   --no-env       start the container only, don't touch .env
#   --dry-run      print what would happen, change nothing
#
set -euo pipefail

# Repo root is derived from THIS SCRIPT's location, not the invoker's cwd —
# running the installer from another checkout must not write .env there.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(git -C "$HERE" rev-parse --show-toplevel)"

PORT=8880
VOICE="af_heart"
# Pinned per docs/skill-guidelines.md ("pin the version; reject latest").
# Bump deliberately: check https://github.com/remsky/Kokoro-FastAPI/releases
# (and confirm the tag exists for the cpu/gpu variant you're pulling) first.
TAG="${KOKORO_TAG:-v0.2.4}"
VARIANT="cpu"
NAME="nanoclaw-kokoro-tts"
DRY=0
SKIP_RUN=0
NO_ENV=0

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --voice) VOICE="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --gpu) VARIANT="gpu"; shift ;;
    --skip-run) SKIP_RUN=1; shift ;;
    --no-env) NO_ENV=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

IMAGE="ghcr.io/remsky/kokoro-fastapi-${VARIANT}:${TAG}"
ENDPOINT="http://127.0.0.1:${PORT}"

run() {
  if [ "$DRY" = 1 ]; then echo "+ $*"; else "$@"; fi
}

# Idempotent upsert of a KEY=VALUE line in .env (create .env if absent).
set_env() {
  local key="$1" val="$2" file=".env"
  if [ "$DRY" = 1 ]; then echo "+ set ${key}=${val} in ${file}"; return; fi
  [ -f "$file" ] || touch "$file"
  if grep -q "^${key}=" "$file"; then
    # Portable in-place edit (GNU/BSD sed differ on -i); use a temp file.
    grep -v "^${key}=" "$file" > "$file.tmp" && mv "$file.tmp" "$file"
  fi
  printf '%s=%s\n' "$key" "$val" >> "$file"
}

echo "→ Kokoro-FastAPI TTS install"
echo "  image:    $IMAGE"
echo "  endpoint: $ENDPOINT  (loopback only)"
echo "  voice:    $VOICE"
echo

if ! command -v docker >/dev/null 2>&1; then
  echo "✗ docker not found — install Docker first." >&2
  exit 1
fi

# ── 1. Container ───────────────────────────────────────────────────────────
if [ "$SKIP_RUN" = 0 ]; then
  # Replace any prior instance so re-runs pick up a new tag/port cleanly.
  run docker rm -f "$NAME" >/dev/null 2>&1 || true
  echo "→ Starting $NAME on 127.0.0.1:${PORT} (local-only)…"
  # Bind loopback ONLY. Never 0.0.0.0 — this port would otherwise be an open,
  # unauthenticated synthesis service.
  GPU_ARGS=()
  if [ "$VARIANT" = "gpu" ]; then
    GPU_ARGS=(--gpus all)
    echo "  (GPU variant — requires the NVIDIA container toolkit on the host)"
  fi
  run docker run -d --name "$NAME" --restart unless-stopped \
    -p "127.0.0.1:${PORT}:8880" \
    ${GPU_ARGS[@]+"${GPU_ARGS[@]}"} \
    "$IMAGE"

  # ── 2. Health check ──────────────────────────────────────────────────────
  if [ "$DRY" = 0 ]; then
    echo -n "→ Waiting for the backend to answer"
    ok=0
    for _ in $(seq 1 60); do
      if curl -fsS --max-time 2 "${ENDPOINT}/health" >/dev/null 2>&1 \
        || curl -fsS --max-time 2 "${ENDPOINT}/v1/audio/voices" >/dev/null 2>&1; then
        ok=1; break
      fi
      echo -n "."; sleep 2
    done
    echo
    if [ "$ok" = 1 ]; then
      echo "✓ Backend is up at ${ENDPOINT}"
    else
      echo "⚠ Backend didn't answer within ~2min. First boot downloads the model"
      echo "  (~330MB) and can be slow. Check: docker logs ${NAME}"
    fi
  fi
fi

# ── 3. Wire the webchat host via .env ──────────────────────────────────────
if [ "$NO_ENV" = 0 ]; then
  echo "→ Writing WEBCHAT_TTS_* to .env"
  set_env WEBCHAT_TTS_ENABLED true
  set_env WEBCHAT_TTS_ENDPOINT "$ENDPOINT"
  set_env WEBCHAT_TTS_MODEL kokoro
  set_env WEBCHAT_TTS_VOICE "$VOICE"
fi

cat <<EOF

──────────────────────────────────────────────────────────────────────────
Kokoro TTS backend installed.

  Endpoint:   ${ENDPOINT}        (loopback only — never expose this port)
  Container:  ${NAME}            (docker logs ${NAME})
  Voices:     curl -s ${ENDPOINT}/v1/audio/voices

Restart the webchat host so it picks up the new .env, then reload the PWA —
agent messages gain a "read aloud" control:

  systemctl --user restart nanoclaw          # Linux
  launchctl kickstart -k gui/\$(id -u)/com.nanoclaw   # macOS

Quick backend smoke test:
  curl -s ${ENDPOINT}/v1/audio/speech \\
    -H 'Content-Type: application/json' \\
    -d '{"model":"kokoro","voice":"${VOICE}","input":"Hello from Kokoro.","response_format":"mp3"}' \\
    --output /tmp/tts-test.mp3 && echo "wrote /tmp/tts-test.mp3"
──────────────────────────────────────────────────────────────────────────
EOF
