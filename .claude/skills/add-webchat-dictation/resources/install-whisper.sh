#!/usr/bin/env bash
#
# install-whisper.sh — idempotent installer for a local whisper.cpp STT backend,
# wired to the webchat channel's /api/stt/transcribe proxy (src/channels/webchat/
# stt.ts).
#
# One job: run a local-only whisper.cpp `whisper-server` container with a pinned
# ggml model, then point the webchat host at it via WEBCHAT_STT_* in .env.
# Local is the recommended default — audio never leaves the machine. (The cloud
# alternative, ElevenLabs, is configured from Settings → Features and never
# touches this script.)
#
# The endpoint binds to 127.0.0.1 only. Browsers never reach it directly — they
# POST WAV segments to the webchat origin's /api/stt/transcribe, which forwards
# here, so dictation works over Tailscale/remote access too.
#
# Flags / env:
#   --model <name>   tiny|tiny.en|base|base.en|small|small.en|medium|medium.en
#                    (default: hardware-suggested — see suggest_model below)
#   --port <n>       host loopback port for the backend      (default 8771)
#   --lang <code>    default language ('auto' = detect)      (default auto)
#   --url <url>      skip the container entirely — point WEBCHAT_STT_URL at an
#                    existing whisper.cpp / OpenAI-compatible server (GPU box)
#   --skip-run       write .env config only, don't (re)start the container
#   --no-env         start the container only, don't touch .env
#   --dry-run        print what would happen, change nothing
#
set -euo pipefail

# Repo root is derived from THIS SCRIPT's location, not the invoker's cwd.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(git -C "$HERE" rev-parse --show-toplevel)"

# Pinned per docs/skill-guidelines.md ("pin the version; reject latest").
# Image: commit-pinned CPU build of ggml-org/whisper.cpp (contains
# /app/build/bin/whisper-server). Bump deliberately: pick a `main-<commit>` tag
# from ghcr.io/ggml-org/whisper.cpp that matches a recent upstream commit.
IMAGE_TAG="${WHISPER_IMAGE_TAG:-main-080bbbe85230f624f0b52127f1ae1218247989f9}"
IMAGE="ghcr.io/ggml-org/whisper.cpp:${IMAGE_TAG}"
# Models: pinned to one immutable revision of huggingface.co/ggerganov/whisper.cpp
# plus per-file sha256 (from the repo's LFS metadata) — verified after download.
HF_REV="5359861c739e955e79d9a303bcbc70fb988958b1"
model_sha() {
  case "$1" in
    tiny)      echo "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21" ;;
    tiny.en)   echo "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f" ;;
    base)      echo "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe" ;;
    base.en)   echo "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002" ;;
    small)     echo "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b" ;;
    small.en)  echo "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d" ;;
    medium)    echo "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208" ;;
    medium.en) echo "cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356" ;;
    *) echo "" ;;
  esac
}

# Same rules as the Ollama install: probe hardware, suggest a size. Multilingual
# by default; callers can pick a .en variant for speed.
suggest_model() {
  local cores mem_kb mem_gb
  cores=$(nproc 2>/dev/null || echo 2)
  mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 4000000)
  mem_gb=$((mem_kb / 1024 / 1024))
  if command -v nvidia-smi >/dev/null 2>&1 || { [ "$cores" -ge 8 ] && [ "$mem_gb" -ge 15 ]; }; then
    echo small
  elif [ "$cores" -ge 4 ] && [ "$mem_gb" -ge 7 ]; then
    echo base
  else
    echo tiny
  fi
}

MODEL=""
PORT=8771
LANG_CODE="auto"
EXTERNAL_URL=""
NAME="nanoclaw-whisper-stt"
DRY=0
SKIP_RUN=0
NO_ENV=0

while [ $# -gt 0 ]; do
  case "$1" in
    --model) MODEL="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --lang) LANG_CODE="$2"; shift 2 ;;
    --url) EXTERNAL_URL="$2"; shift 2 ;;
    --skip-run) SKIP_RUN=1; shift ;;
    --no-env) NO_ENV=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

[ -n "$MODEL" ] || MODEL="$(suggest_model)"
SHA="$(model_sha "$MODEL")"
if [ -z "$SHA" ] && [ -z "$EXTERNAL_URL" ]; then
  echo "✗ Unknown model '$MODEL' (tiny|tiny.en|base|base.en|small|small.en|medium|medium.en)" >&2
  exit 2
fi

run() {
  if [ "$DRY" = 1 ]; then echo "+ $*"; else "$@"; fi
}

# Idempotent upsert of a KEY=VALUE line in .env (create .env if absent).
set_env() {
  local key="$1" val="$2" file=".env"
  if [ "$DRY" = 1 ]; then echo "+ set ${key}=${val} in ${file}"; return; fi
  [ -f "$file" ] || touch "$file"
  if grep -q "^${key}=" "$file"; then
    grep -v "^${key}=" "$file" > "$file.tmp" && mv "$file.tmp" "$file"
  fi
  printf '%s=%s\n' "$key" "$val" >> "$file"
}

echo "→ whisper.cpp STT install"
if [ -n "$EXTERNAL_URL" ]; then
  echo "  mode:     external endpoint (no container)"
  echo "  url:      $EXTERNAL_URL"
else
  echo "  image:    $IMAGE"
  echo "  model:    ggml-${MODEL}.bin  (suggested for this machine: $(suggest_model))"
  echo "  endpoint: http://127.0.0.1:${PORT}  (loopback only)"
fi
echo

# ── external-URL mode: env only ─────────────────────────────────────────────
if [ -n "$EXTERNAL_URL" ]; then
  if [ "$NO_ENV" = 0 ]; then
    set_env WEBCHAT_STT_ENABLED true
    set_env WEBCHAT_STT_PROVIDER openai-compat
    set_env WEBCHAT_STT_URL "$EXTERNAL_URL"
    set_env WEBCHAT_STT_MODEL "$MODEL"
    set_env WEBCHAT_STT_LANG "$LANG_CODE"
  fi
  echo "✓ Configured against external endpoint. Restart not needed if installed"
  echo "  from Settings (the server activates .env in-process)."
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "✗ docker not found — install Docker first." >&2
  exit 1
fi

# ── 1. Model download (pinned revision + sha256 verify) ─────────────────────
MODELS_DIR="data/stt/models"
MODEL_FILE="${MODELS_DIR}/ggml-${MODEL}.bin"
mkdir -p "$MODELS_DIR"
if [ -f "$MODEL_FILE" ] && echo "${SHA}  ${MODEL_FILE}" | sha256sum -c --quiet - 2>/dev/null; then
  echo "→ Model already present and verified: $MODEL_FILE"
else
  URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/${HF_REV}/ggml-${MODEL}.bin"
  echo "→ Downloading ggml-${MODEL}.bin (pinned revision ${HF_REV:0:12}…)"
  if [ "$DRY" = 1 ]; then
    echo "+ curl -fLsS --retry 3 -o ${MODEL_FILE}.part $URL"
  else
    # Newline-based progress (one line every ~2s) — plays well with the
    # Settings install log, which renders line by line.
    curl -fLsS --retry 3 -o "${MODEL_FILE}.part" "$URL" &
    CURL_PID=$!
    while kill -0 "$CURL_PID" 2>/dev/null; do
      sleep 2
      SZ=$(stat -c %s "${MODEL_FILE}.part" 2>/dev/null || echo 0)
      echo "  … $((SZ / 1024 / 1024)) MB"
    done
    wait "$CURL_PID" || { echo "✗ Download failed" >&2; rm -f "${MODEL_FILE}.part"; exit 1; }
  fi
  if [ "$DRY" = 0 ]; then
    echo "→ Verifying sha256…"
    echo "${SHA}  ${MODEL_FILE}.part" | sha256sum -c --quiet - || {
      echo "✗ sha256 mismatch — refusing to install this file." >&2
      rm -f "${MODEL_FILE}.part"
      exit 1
    }
    mv "${MODEL_FILE}.part" "$MODEL_FILE"
  fi
  echo "✓ Model verified"
fi

# ── 2. Image: prebuilt if this CPU can run it, else build from pinned source ─
# The official images are compiled on AVX-512 CI runners with no runtime
# dispatch — on older CPUs (e.g. Coffee Lake) every compute call SIGILLs.
# Probe with a real 1-shot transcription; on crash, build the same pinned
# commit locally (-march=native on THIS cpu — compatible and fastest).
WHISPER_COMMIT="${IMAGE_TAG#main-}"
LOCAL_IMAGE="nanoclaw-whisper-stt-img:${WHISPER_COMMIT:0:12}"
if [ "$SKIP_RUN" = 0 ] && [ "$DRY" = 0 ]; then
  if docker image inspect "$LOCAL_IMAGE" >/dev/null 2>&1; then
    echo "→ Using locally built image (cached): $LOCAL_IMAGE"
    IMAGE="$LOCAL_IMAGE"
  else
    echo "→ Pulling $IMAGE …"
    docker pull -q "$IMAGE"
    echo "→ Probing the prebuilt binary on this CPU…"
    if timeout 120 docker run --rm \
        -v "$PWD/$MODELS_DIR:/models:ro" -v "$HERE:/probe:ro" \
        "$IMAGE" \
        "/app/build/bin/whisper-cli -m /models/ggml-${MODEL}.bin -f /probe/fixture.wav --no-timestamps" \
        >/dev/null 2>&1; then
      echo "✓ Prebuilt image works on this CPU"
    else
      echo "✗ Prebuilt image crashed (needs CPU features this machine lacks)"
      echo "→ Building whisper.cpp from pinned source ${WHISPER_COMMIT:0:12}… on this CPU"
      echo "  (one-time, ~5-10 min — the log below is the compiler)"
      docker build -t "$LOCAL_IMAGE" \
        --build-arg WHISPER_COMMIT="$WHISPER_COMMIT" \
        -f "$HERE/Dockerfile.whisper" "$HERE"
      IMAGE="$LOCAL_IMAGE"
      echo "✓ Built $LOCAL_IMAGE"
    fi
  fi
fi

# ── 3. Container ─────────────────────────────────────────────────────────────
if [ "$SKIP_RUN" = 0 ]; then
  # Replace any prior instance so re-runs pick up a new model/port cleanly.
  run docker rm -f "$NAME" >/dev/null 2>&1 || true
  echo "→ Starting $NAME on 127.0.0.1:${PORT} (local-only)…"
  # Bind loopback ONLY. Never 0.0.0.0 — this port would otherwise be an open,
  # unauthenticated transcription service.
  run docker run -d --name "$NAME" --restart unless-stopped \
    -p "127.0.0.1:${PORT}:8080" \
    -v "$PWD/$MODELS_DIR:/models:ro" \
    "$IMAGE" \
    "/app/build/bin/whisper-server -m /models/ggml-${MODEL}.bin --host 0.0.0.0 --port 8080 --threads $(( $(nproc) > 4 ? 4 : $(nproc) ))"
fi

# ── 4. Health check ──────────────────────────────────────────────────────────
if [ "$DRY" = 0 ] && [ "$SKIP_RUN" = 0 ]; then
  echo -n "→ Waiting for the backend to answer"
  ok=0
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
      ok=1; break
    fi
    echo -n "."
    sleep 2
  done
  echo
  if [ "$ok" = 0 ]; then
    echo "✗ Backend did not come up — check: docker logs $NAME" >&2
    exit 1
  fi
  echo "✓ Backend is up at http://127.0.0.1:${PORT}"
  # Smoke test with the checked-in fixture (spoken phrase) when present.
  FIXTURE="$HERE/fixture.wav"
  if [ -f "$FIXTURE" ]; then
    echo "→ Smoke test: transcribing fixture.wav…"
    OUT=$(curl -fsS --max-time 60 "http://127.0.0.1:${PORT}/inference" \
      -F "file=@${FIXTURE}" -F response_format=text -F no_timestamps=true 2>/dev/null || echo "")
    echo "  transcript: ${OUT:0:120}"
  fi
fi

# ── 5. Wire .env ─────────────────────────────────────────────────────────────
if [ "$NO_ENV" = 0 ]; then
  echo "→ Writing WEBCHAT_STT_* to .env"
  set_env WEBCHAT_STT_ENABLED true
  set_env WEBCHAT_STT_PROVIDER local
  set_env WEBCHAT_STT_URL "http://127.0.0.1:${PORT}"
  set_env WEBCHAT_STT_MODEL "$MODEL"
  set_env WEBCHAT_STT_LANG "$LANG_CODE"
fi

echo
echo "──────────────────────────────────────────────────────────────────────────"
echo "whisper.cpp STT backend installed."
echo
echo "  Endpoint:   http://127.0.0.1:${PORT}      (loopback only — never expose this port)"
echo "  Container:  $NAME                          (docker logs $NAME)"
echo "  Model:      $MODEL_FILE"
echo
echo "Installed from Settings → Features? Nothing else to do — the server"
echo "activates the .env keys in-process and the mic appears in the composer."
echo "Installed from a shell against a running host? Restart it once:"
echo "  systemctl --user restart nanoclaw   # Linux"
echo "  launchctl kickstart -k gui/\$(id -u)/com.nanoclaw   # macOS"
echo "──────────────────────────────────────────────────────────────────────────"
