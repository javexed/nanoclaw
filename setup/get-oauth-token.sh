#!/usr/bin/env bash
set -euo pipefail

# Get a provider OAuth credential by running its sign-in CLI inside a throwaway
# agent container, then register it with the OneCLI vault. The HOST needs no
# provider CLI installed — the agent image ships them.
#
# Containerized sibling of register-claude-token.sh (which runs `claude
# setup-token` directly on the host) and setup/providers/codex.ts (host codex).
#
# Usage:
#   setup/get-oauth-token.sh claude     # Claude subscription OAuth token
#   setup/get-oauth-token.sh codex      # ChatGPT subscription (device-auth)
#
# The two providers have genuinely different credential shapes:
#   claude — `claude setup-token` prints an sk-ant-oat… token to the terminal;
#            we PTY-capture it (script(1)), parse it, and store the string.
#   codex  — `codex login --device-auth` writes a whole auth.json under a
#            *throwaway* CODEX_HOME (mounted from the host); we store the FILE.
#            A throwaway login (never the user's ~/.codex) is deliberate: OpenAI
#            rotates refresh tokens, so sharing one session strands consumers
#            (same invariant as setup/providers/codex.ts).
#
# Env overrides (advanced): SECRET_NAME, IMAGE_TAG, CONTAINER_RUNTIME.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PROVIDER="${1:-}"
case "$PROVIDER" in
  claude | codex) ;;
  '') echo "usage: $(basename "$0") <claude|codex>" >&2; exit 2 ;;
  *) echo "Unknown provider '$PROVIDER'. Supported: claude, codex." >&2; exit 2 ;;
esac

# ── Shared preconditions ─────────────────────────────────────────────────────
command -v onecli >/dev/null \
  || { echo "onecli not found. Install the OneCLI vault first (see /init-onecli)." >&2; exit 1; }

CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"
command -v "$CONTAINER_RUNTIME" >/dev/null \
  || { echo "Container runtime '$CONTAINER_RUNTIME' not found." >&2; exit 1; }

# Image name is install-scoped (two installs on one host don't clash) — same
# derivation build.sh uses.
# shellcheck source=lib/install-slug.sh
source "$PROJECT_ROOT/setup/lib/install-slug.sh"
IMAGE="$(container_image_base):${IMAGE_TAG:-latest}"

if ! "$CONTAINER_RUNTIME" image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Agent image '$IMAGE' not found — building it now (one-time, a few minutes)…"
  if ! bash "$PROJECT_ROOT/container/build.sh"; then
    echo "Image build failed. Run ./container/build.sh manually, then retry." >&2
    exit 1
  fi
fi

# Provider CLI must be present in the agent image. Claude is baked into the base
# image; Codex arrives only with the Codex provider (/add-codex adds it to
# cli-tools.json and rebuilds), so a base-only install won't have it yet.
if ! "$CONTAINER_RUNTIME" run --rm --entrypoint sh "$IMAGE" -c "command -v $PROVIDER" >/dev/null 2>&1; then
  if [ "$PROVIDER" = "codex" ]; then
    echo "The Codex CLI isn't in the agent image yet. Install the Codex provider first:" >&2
    echo "  pnpm exec tsx setup/index.ts --step provider-auth codex   (or the /add-codex skill)" >&2
    echo "That adds the Codex CLI to the image — then retry this command." >&2
  else
    echo "The '$PROVIDER' CLI isn't in the agent image. Rebuild it: ./container/build.sh" >&2
  fi
  exit 1
fi

confirm() {
  cat <<EOF

$1

Press Enter to continue, or Ctrl-C to abort.
EOF
  read -r _ </dev/tty || true
}

# ── claude: PTY-capture the printed sk-ant-oat… token ────────────────────────
get_claude() {
  command -v script >/dev/null \
    || { echo "script(1) is required for PTY capture." >&2; exit 1; }

  local secret_name="${SECRET_NAME:-Anthropic}"
  local tmpfile token keep
  tmpfile="$(mktemp -t get-oauth-token.XXXXXX)"
  trap 'rm -f "$tmpfile"' RETURN

  confirm "Signing in to Claude. A sign-in link will appear — open it, finish
signing in, and paste any code it gives you back here. The token is saved to
your OneCLI vault automatically."

  # --entrypoint overrides the image's agent-runner; -it gives setup-token the
  # interactive TTY it needs (provided through script(1)'s PTY). --rm discards
  # the container — only the captured token survives.
  local run_cmd="$CONTAINER_RUNTIME run --rm -it --entrypoint claude $IMAGE setup-token"
  if script --version 2>/dev/null | grep -q util-linux; then
    script -q -c "$run_cmd" "$tmpfile"
  else
    # shellcheck disable=SC2086
    script -q "$tmpfile" $run_cmd
  fi

  token="$(cd "$PROJECT_ROOT" && pnpm exec tsx "$SCRIPT_DIR/lib/captured-token.ts" claude "$tmpfile" || true)"
  if [ -z "$token" ]; then
    keep="$(mktemp -t get-oauth-token-log.XXXXXX)"; cp "$tmpfile" "$keep"
    echo >&2; echo "No sk-ant-oat…AA token found. Raw log: $keep" >&2
    exit 1
  fi

  echo; echo "Got token: ${token:0:16}…${token: -4}"
  echo "Saving to OneCLI vault as '${secret_name}' (host: api.anthropic.com)…"
  onecli secrets create --name "$secret_name" --type anthropic --value "$token" --host-pattern api.anthropic.com
  echo "Done."
}

# ── codex: device-auth writes auth.json to a mounted throwaway CODEX_HOME ─────
get_codex() {
  local secret_name="${SECRET_NAME:-Codex}"
  local home authjson
  home="$(mktemp -d -t codex-vault-login.XXXXXX)"
  # The container writes auth.json here; --user (below) makes it host-owned so we
  # can read it back. Discard the whole dir on the way out — never our long-lived
  # copy of a credential.
  trap 'rm -rf "$home"' RETURN

  confirm "Signing in to Codex (ChatGPT subscription). A URL and a pairing code
will appear — open the URL, enter the code, and approve. Your credentials are
saved to your OneCLI vault automatically."

  # device-auth is the headless flow (URL + code, no browser in the container).
  # --user host:host so the written auth.json is readable back on the host;
  # HOME + CODEX_HOME both point at the writable mount.
  "$CONTAINER_RUNTIME" run --rm -it \
    --user "$(id -u):$(id -g)" \
    -e HOME=/codexhome -e CODEX_HOME=/codexhome \
    -v "$home":/codexhome \
    --entrypoint codex "$IMAGE" login --device-auth

  authjson="$home/auth.json"
  if [ ! -f "$authjson" ]; then
    echo >&2; echo "Codex login finished but no auth.json was written. Try again." >&2
    exit 1
  fi

  echo; echo "Saving Codex credentials to OneCLI vault as '${secret_name}' (host: chatgpt.com)…"
  onecli secrets create --name "$secret_name" --type openai --file "$authjson" --host-pattern chatgpt.com
  echo "Done."
}

case "$PROVIDER" in
  claude) get_claude ;;
  codex) get_codex ;;
esac
