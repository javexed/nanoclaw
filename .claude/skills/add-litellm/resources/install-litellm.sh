#!/usr/bin/env bash
#
# install-litellm.sh — idempotent installer for the minimal LiteLLM router
# (docs/webchat/design/add-litellm.md).
#
# One job: run a local-only LiteLLM container whose model_list is generated
# from the configured local model server(s) — Ollama by default; any keyless
# OpenAI-compatible server (vLLM, LM Studio, llama.cpp, TGI, …) works too —
# plus, opt-in, declared keyed backends (data/litellm/backends.json). No
# routing/classifier logic — dependent skills layer that on separately.
#
# Keyless by default. Declaring any keyed backend turns on proxy auth
# (master_key) automatically; key values live only in data/litellm/env
# (mode 600), read by the LiteLLM container via --env-file.
#
# Flags / env:
#   --dry-run          print what would happen, change nothing
#   --port <n>         listen port                          (default 4000)
#   --tag <t>          LiteLLM image tag (LITELLM_TAG env)  (default: pinned, see below)
#   --hosts <csv>      model-server hosts (MODEL_HOSTS env) (default http://localhost:11434)
#   --backends <file>  keyed-backend declarations           (default data/litellm/backends.json if present)
#   --skip-run         generate config only, don't (re)start the container
#
set -euo pipefail

# Repo root is derived from THIS SCRIPT's location, not the invoker's cwd —
# running the installer from another checkout must not write data/ there.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Repo root: prefer git, but fall back to the known depth (resources → add-litellm
# → skills → .claude → root) so a non-git checkout doesn't spew "fatal: not a git
# repository" and mis-target data/.
TOPLEVEL="$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null || true)"
cd "${TOPLEVEL:-$(cd "$HERE/../../../.." && pwd)}"

PORT=4000
# Pinned per docs/skill-guidelines.md ("pin the version; reject latest").
# Bump deliberately: check https://github.com/BerriAI/litellm/releases first.
TAG="${LITELLM_TAG:-v1.90.0}"
HOSTS="${MODEL_HOSTS:-http://localhost:11434}"
BACKENDS=""
DRY=0
SKIP_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --port) PORT="$2"; shift ;;
    --tag) TAG="$2"; shift ;;
    --hosts) HOSTS="$2"; shift ;;
    --backends) BACKENDS="$2"; shift ;;
    --skip-run) SKIP_RUN=1 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

IMAGE="ghcr.io/berriai/litellm:${TAG}"
NAME="nanoclaw-litellm"
OUT_DIR="data/litellm"
KEYFILE="$OUT_DIR/master.key"
ENVFILE="$OUT_DIR/env"
[ -z "$BACKENDS" ] && [ -f "$OUT_DIR/backends.json" ] && BACKENDS="$OUT_DIR/backends.json"

run() { if [ "$DRY" = 1 ]; then echo "DRY-RUN: $*"; else "$@"; fi; }

command -v docker >/dev/null || { echo "install-litellm: docker is required" >&2; exit 1; }
command -v node >/dev/null || { echo "install-litellm: node is required (config generator)" >&2; exit 1; }

# ── 1. Reach at least one model server ────────────────────────────────────
#      Ollama answers /api/tags; any other OpenAI-compatible server answers
#      /v1/models. The generator re-probes every host the same way. With
#      keyed backends declared, --hosts '' (no local servers) is legitimate.
FIRST_HOST="${HOSTS%%,*}"
if [ -n "$FIRST_HOST" ] \
   && ! curl -fsS --max-time 5 "${FIRST_HOST}/api/tags" >/dev/null 2>&1 \
   && ! curl -fsS --max-time 5 "${FIRST_HOST}/v1/models" >/dev/null 2>&1; then
  echo "install-litellm: no model server reachable at ${FIRST_HOST}." >&2
  echo "  Start one first — Ollama (https://ollama.com) with a model pulled, or any" >&2
  echo "  OpenAI-compatible server (vLLM, LM Studio, llama.cpp) — then re-run." >&2
  echo "  Multiple hosts: --hosts http://localhost:11434,http://<lan-ip>:8000" >&2
  exit 1
fi

run mkdir -p "$OUT_DIR"

# ── 2. Keyed mode: master key + env file ──────────────────────────────────
GEN_ARGS=(--hosts "$HOSTS" --out "$OUT_DIR/config.yaml")
DOCKER_ENV=()
KEYED=0
if [ -n "$BACKENDS" ]; then
  KEYED=1
  [ -f "$BACKENDS" ] || { echo "install-litellm: --backends $BACKENDS not found" >&2; exit 1; }
  GEN_ARGS+=(--backends "$BACKENDS")

  # Proxy auth is mandatory once a paid key sits behind the endpoint.
  if [ ! -f "$KEYFILE" ]; then
    echo "→ Generating proxy master key ($KEYFILE) …"
    if [ "$DRY" = 1 ]; then echo "DRY-RUN: write $KEYFILE (mode 600)"; else
      (umask 077; printf 'sk-%s' "$(openssl rand -hex 32 2>/dev/null || head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n')" > "$KEYFILE")
    fi
  fi

  # Key VALUES live in the env file (mode 600), read only by the container.
  if [ "$DRY" = 1 ]; then echo "DRY-RUN: ensure $ENVFILE (mode 600) with LITELLM_MASTER_KEY + backend keys"; else
    (umask 077; touch "$ENVFILE")
    grep -q '^LITELLM_MASTER_KEY=' "$ENVFILE" 2>/dev/null \
      || printf 'LITELLM_MASTER_KEY=%s\n' "$(cat "$KEYFILE")" >> "$ENVFILE"
    # Every api_key_env declared in backends.json must have a value.
    missing=$(node -e '
      const fs = require("fs");
      const wanted = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).map(b => b.api_key_env);
      const have = new Set(fs.readFileSync(process.argv[2], "utf8").split("\n").map(l => l.split("=")[0]));
      console.log(wanted.filter(w => !have.has(w)).join(" "));
    ' "$BACKENDS" "$ENVFILE")
    if [ -n "$missing" ]; then
      echo "install-litellm: $ENVFILE is missing values for: $missing" >&2
      echo "  Add one NAME=value line per key (file is mode 600, gitignored via data/)," >&2
      echo "  then re-run. Key values never go in backends.json or config.yaml." >&2
      exit 1
    fi
  fi
  DOCKER_ENV=(--env-file "$ENVFILE")
fi

# ── 3. Generate config.yaml ───────────────────────────────────────────────
echo "→ Generating LiteLLM config.yaml from the model-server roster(s) …"
run node "$HERE/gen-config.mjs" "${GEN_ARGS[@]}"

# ── 4. Bind addresses: localhost + docker bridge (agents reach it via
#      host.docker.internal → the bridge IP). Never 0.0.0.0. ───────────────
BRIDGE_IP=$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || echo "172.17.0.1")
PORTS=(-p "127.0.0.1:${PORT}:4000" -p "${BRIDGE_IP}:${PORT}:4000")

# ── 5. Run (or replace) the container ─────────────────────────────────────
if [ "$SKIP_RUN" = 1 ]; then
  echo "= --skip-run: config written to $OUT_DIR; container not started."
  exit 0
fi
if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "= Existing $NAME container found — replacing (config may have changed)."
  run docker rm -f "$NAME"
fi
MODE_DESC="keyless"; [ "$KEYED" = 1 ] && MODE_DESC="keyed (proxy auth on)"
echo "→ Starting $IMAGE on 127.0.0.1:${PORT} + ${BRIDGE_IP}:${PORT} (${MODE_DESC}, local-only) …"
run docker run -d --name "$NAME" --restart unless-stopped \
  "${PORTS[@]}" \
  ${DOCKER_ENV[@]+"${DOCKER_ENV[@]}"} \
  --add-host=host.docker.internal:host-gateway \
  -v "$(pwd)/$OUT_DIR/config.yaml:/app/config.yaml:ro" \
  "$IMAGE" --config /app/config.yaml --port 4000

# ── 6. Health check (authed when keyed) ───────────────────────────────────
if [ "$DRY" = 0 ]; then
  AUTH=()
  [ "$KEYED" = 1 ] && AUTH=(-H "Authorization: Bearer $(cat "$KEYFILE")")
  echo "→ Waiting for /v1/models …"
  for i in $(seq 1 30); do
    if curl -fsS --max-time 2 ${AUTH[@]+"${AUTH[@]}"} "http://127.0.0.1:${PORT}/v1/models" >/dev/null 2>&1; then
      echo "✓ LiteLLM healthy."
      break
    fi
    [ "$i" = 30 ] && { echo "✗ LiteLLM did not become healthy — docker logs $NAME" >&2; exit 1; }
    sleep 2
  done
fi

cat <<DONE

✓ LiteLLM router installed (${MODE_DESC}, local-only).

  Endpoint (from host):        http://127.0.0.1:${PORT}/v1
  Endpoint (from containers):  http://host.docker.internal:${PORT}/v1
  Config:                      $OUT_DIR/config.yaml
  Admin UI:                    http://127.0.0.1:${PORT}/ui

Roster or backends changed? Re-run this script.
DONE

if [ "$KEYED" = 1 ]; then
  cat <<'KEYED_DONE'
Keyed mode — the router now requires "Authorization: Bearer <master key>"
(data/litellm/master.key). Give agents access the sanctioned way — register
the master key in OneCLI so the gateway injects it per request (no restarts):

  onecli secrets create --name "LiteLLM router" --type generic \
    --value "$(cat data/litellm/master.key)" --host-pattern "host.docker.internal" \
    --header-name "Authorization" --value-format "Bearer {value}"

Never expose this port beyond localhost/bridge; TLS is owed before it ever
leaves the machine.
KEYED_DONE
fi
