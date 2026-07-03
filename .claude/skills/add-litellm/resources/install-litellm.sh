#!/usr/bin/env bash
#
# install-litellm.sh — idempotent installer for the minimal LiteLLM router
# (docs/design/add-litellm.md).
#
# One job: run a keyless, local-only LiteLLM container whose model_list is
# generated from the configured local model server(s) — Ollama by default;
# any keyless OpenAI-compatible server (vLLM, LM Studio, llama.cpp, TGI, …)
# works too. No routing/classifier logic — dependent skills layer that on
# separately.
#
# Flags / env:
#   --dry-run          print what would happen, change nothing
#   --port <n>         listen port                          (default 4000)
#   --tag <t>          LiteLLM image tag (LITELLM_TAG env)  (default: pinned, see below)
#   --hosts <csv>      model-server hosts (MODEL_HOSTS env) (default http://localhost:11434)
#   --skip-run         generate config only, don't (re)start the container
#
set -euo pipefail

# Repo root is derived from THIS SCRIPT's location, not the invoker's cwd —
# running the installer from another checkout must not write data/ there.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(git -C "$HERE" rev-parse --show-toplevel)"

PORT=4000
# Pinned per docs/skill-guidelines.md ("pin the version; reject latest").
# Bump deliberately: check https://github.com/BerriAI/litellm/releases first.
TAG="${LITELLM_TAG:-v1.90.0}"
HOSTS="${MODEL_HOSTS:-http://localhost:11434}"
DRY=0
SKIP_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --port) PORT="$2"; shift ;;
    --tag) TAG="$2"; shift ;;
    --hosts) HOSTS="$2"; shift ;;
    --skip-run) SKIP_RUN=1 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

IMAGE="ghcr.io/berriai/litellm:${TAG}"
NAME="nanoclaw-litellm"
OUT_DIR="data/litellm"

run() { if [ "$DRY" = 1 ]; then echo "DRY-RUN: $*"; else "$@"; fi; }

command -v docker >/dev/null || { echo "install-litellm: docker is required" >&2; exit 1; }
command -v node >/dev/null || { echo "install-litellm: node is required (config generator)" >&2; exit 1; }

# ── 1. Reach at least one model server ────────────────────────────────────
#      Ollama answers /api/tags; any other OpenAI-compatible server answers
#      /v1/models. The generator re-probes every host the same way.
FIRST_HOST="${HOSTS%%,*}"
if ! curl -fsS --max-time 5 "${FIRST_HOST}/api/tags" >/dev/null 2>&1 \
   && ! curl -fsS --max-time 5 "${FIRST_HOST}/v1/models" >/dev/null 2>&1; then
  echo "install-litellm: no model server reachable at ${FIRST_HOST}." >&2
  echo "  Start one first — Ollama (https://ollama.com) with a model pulled, or any" >&2
  echo "  OpenAI-compatible server (vLLM, LM Studio, llama.cpp) — then re-run." >&2
  echo "  Multiple hosts: --hosts http://localhost:11434,http://<lan-ip>:8000" >&2
  exit 1
fi

# ── 2. Generate config.yaml ───────────────────────────────────────────────
run mkdir -p "$OUT_DIR"
echo "→ Generating LiteLLM config.yaml from the model-server roster(s) …"
run node "$HERE/gen-config.mjs" --hosts "$HOSTS" --out "$OUT_DIR/config.yaml"

# ── 3. Bind addresses: localhost + docker bridge (agents reach it via
#      host.docker.internal → the bridge IP). Never 0.0.0.0. ───────────────
BRIDGE_IP=$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || echo "172.17.0.1")
PORTS=(-p "127.0.0.1:${PORT}:4000" -p "${BRIDGE_IP}:${PORT}:4000")

# ── 4. Run (or replace) the container ─────────────────────────────────────
if [ "$SKIP_RUN" = 1 ]; then
  echo "= --skip-run: config written to $OUT_DIR; container not started."
  exit 0
fi
if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "= Existing $NAME container found — replacing (config may have changed)."
  run docker rm -f "$NAME"
fi
echo "→ Starting $IMAGE on 127.0.0.1:${PORT} + ${BRIDGE_IP}:${PORT} (keyless, local-only) …"
run docker run -d --name "$NAME" --restart unless-stopped \
  "${PORTS[@]}" \
  --add-host=host.docker.internal:host-gateway \
  -v "$(pwd)/$OUT_DIR/config.yaml:/app/config.yaml:ro" \
  "$IMAGE" --config /app/config.yaml --port 4000

# ── 5. Health check ────────────────────────────────────────────────────────
if [ "$DRY" = 0 ]; then
  echo "→ Waiting for /v1/models …"
  for i in $(seq 1 30); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/v1/models" >/dev/null 2>&1; then
      echo "✓ LiteLLM healthy."
      break
    fi
    [ "$i" = 30 ] && { echo "✗ LiteLLM did not become healthy — docker logs $NAME" >&2; exit 1; }
    sleep 2
  done
fi

cat <<DONE

✓ LiteLLM router installed (keyless, local-only).

  Endpoint (from host):        http://127.0.0.1:${PORT}/v1
  Endpoint (from containers):  http://host.docker.internal:${PORT}/v1
  Config:                      $OUT_DIR/config.yaml
  Admin UI:                    http://127.0.0.1:${PORT}/ui

Roster changed (models pulled/removed)? Re-run this script.
DONE
