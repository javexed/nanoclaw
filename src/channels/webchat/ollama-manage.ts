/**
 * Backend for the webchat Models tab (owner-only surface). All outbound calls
 * to operator-supplied Ollama endpoints go through models.ts's safeFetch SSRF
 * gate.
 *
 * Kept from the predecessor's 2,100-line console: host model listing
 * (/api/tags merged with /api/ps VRAM state), the streamed pull manager with
 * polled progress snapshots, model delete, the install-chain runner (spawned
 * steps with a capped rolling log) plus the rootless local-Ollama and
 * Tailscale installs it drives, upsertEnv, and the host-restart helpers
 * (cgroup-derived unit).
 *
 * Dropped: LiteLLM/routing, TTS/STT, cloudflared, and every per-provider
 * install machine — providers ship in-tree here, so there is nothing to
 * install at runtime.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { safeFetch } from './models.js';
import { getSystemdUnit, getLaunchdLabel } from '../../install-slug.js';

const LINES_CAP = 200;

interface InstallState {
  running: boolean;
  lines: string[];
  exitCode: number | null;
  startedAt: number | null;
  finishedAt: number | null;
}

// ── Host model listing ─────────────────────────────────────────────────────

export interface HostModel {
  name: string;
  size: number;
  loaded: boolean;
  size_vram: number;
}

export async function listHostModels(host: string): Promise<HostModel[]> {
  const base = host.replace(/\/+$/, '');
  const tagsRes = await safeFetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!tagsRes.ok) throw new Error(`Ollama /api/tags returned ${tagsRes.status}`);
  const tags = (await tagsRes.json()) as { models?: Array<{ name?: string; size?: number }> };
  if (!tags || !Array.isArray(tags.models)) throw new Error('Ollama /api/tags response missing models[]');

  // /api/ps is best-effort — an older Ollama without it still gets a list.
  const loaded = new Map<string, number>();
  try {
    const psRes = await safeFetch(`${base}/api/ps`, { signal: AbortSignal.timeout(5000) });
    if (psRes.ok) {
      const ps = (await psRes.json()) as { models?: Array<{ name?: string; size_vram?: number }> };
      for (const m of ps.models ?? []) {
        if (typeof m.name === 'string') loaded.set(m.name, m.size_vram ?? 0);
      }
    }
  } catch {
    /* ps unavailable — leave everything unloaded */
  }

  return (tags.models ?? [])
    .filter((m): m is { name: string; size?: number } => typeof m.name === 'string')
    .map((m) => ({
      name: m.name,
      size: m.size ?? 0,
      loaded: loaded.has(m.name),
      size_vram: loaded.get(m.name) ?? 0,
    }));
}

// ── Pull manager ───────────────────────────────────────────────────────────

export interface PullJob {
  host: string;
  model: string;
  status: 'pulling' | 'success' | 'error' | 'cancelled';
  /** Last status line from Ollama ("pulling 4f…", "verifying sha256 digest"). */
  detail: string;
  completed: number;
  total: number;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

const FINISHED_JOB_TTL_MS = 10 * 60 * 1000;
const pulls = new Map<string, PullJob>();

/**
 * Abort handles for in-flight pulls, keyed exactly like `pulls`.
 *
 * A SEPARATE map rather than a field on PullJob because that struct is
 * serialized to the browser verbatim by getPullsSnapshot — an AbortController
 * on it would ride along as a meaningless `{}` in every poll response.
 *
 * Cancelling works because Ollama drives the download from the request
 * handler: drop the connection and the daemon stops fetching. Verified against
 * a live daemon rather than assumed. Already-downloaded blobs are kept, so a
 * later re-pull of the same model resumes instead of starting over — which is
 * what makes cancel a cheap, low-regret action worth offering.
 */
const pullAborts = new Map<string, AbortController>();

function pullKey(host: string, model: string): string {
  return `${host.replace(/\/+$/, '')}|${model}`;
}

function prunePulls(now = Date.now()): void {
  for (const [k, job] of pulls) {
    if (job.finishedAt && now - job.finishedAt > FINISHED_JOB_TTL_MS) pulls.delete(k);
  }
}

export function getPullsSnapshot(): PullJob[] {
  prunePulls();
  return [...pulls.values()];
}

/** Test hook — the module-level Map survives across vitest cases otherwise. */
export function _resetPullsForTest(): void {
  for (const c of pullAborts.values()) c.abort();
  pullAborts.clear();
  pulls.clear();
}

/**
 * Start a pull. Returns the job (existing one if the same pull is already
 * running — pressing the button twice must not start two downloads).
 */
/**
 * Ollama model names are lowercase with no whitespace, so a display-style entry
 * like "Qwen 3.5:9B" is invalid and Ollama rejects it with a bare 400. Normalize
 * to the real id ("qwen3.5:9b") so a natural typo just works. Any whitespace is
 * unambiguously invalid in an Ollama ref, so stripping it is safe.
 */
export function normalizeOllamaModelName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '');
}

/**
 * Remove a model's files from an Ollama host — Ollama's DELETE /api/delete.
 * Goes through safeFetch, so the host passes the same SSRF gate as every
 * other Ollama call; the server never talks to an address the roster/registry
 * plumbing wouldn't. Errors surface to the caller — a delete that silently
 * "succeeded" while the files remain is worse than a loud failure.
 */
export async function deleteHostModel(host: string, rawModel: string): Promise<void> {
  const model = normalizeOllamaModelName(rawModel);
  const base = host.replace(/\/+$/, '');
  const res = await safeFetch(`${base}/api/delete`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ollama delete failed: HTTP ${res.status}${body ? ` — ${body.slice(0, 120)}` : ''}`);
  }
}

export async function startPull(host: string, rawModel: string): Promise<PullJob> {
  const model = normalizeOllamaModelName(rawModel);
  const key = pullKey(host, model);
  const existing = pulls.get(key);
  if (existing && existing.status === 'pulling') return existing;

  const job: PullJob = {
    host: host.replace(/\/+$/, ''),
    model,
    status: 'pulling',
    detail: 'starting…',
    completed: 0,
    total: 0,
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
  };
  pulls.set(key, job);
  const abort = new AbortController();
  pullAborts.set(key, abort);

  // Validate the endpoint (SSRF gate) BEFORE returning, so a blocked URL is
  // a synchronous 4xx for the caller instead of a background failure.
  // No overall timeout on the stream itself: model pulls legitimately run
  // for many minutes (the curl --max-time lesson). The signal is the ONLY
  // thing that ends it early, and only when a human asks.
  let res: Response;
  try {
    res = await safeFetch(`${job.host}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal: abort.signal,
    });
  } catch (err) {
    pullAborts.delete(key);
    job.status = 'error';
    job.error = err instanceof Error ? err.message : String(err);
    job.finishedAt = Date.now();
    throw err;
  }

  void consumePullStream(job, res, key);
  return job;
}

/**
 * Stop an in-flight pull. Returns false when there is nothing to stop — an
 * unknown pair, or one that already finished — so the route can answer 404
 * rather than pretend it cancelled something.
 *
 * The status is set HERE, before the abort unwinds consumePullStream, so the
 * stream's catch can tell "a human cancelled this" from "the download broke"
 * and not overwrite it with an error the operator never caused.
 */
export function cancelPull(host: string, rawModel: string): boolean {
  const model = normalizeOllamaModelName(rawModel);
  const key = pullKey(host, model);
  const job = pulls.get(key);
  if (!job || job.status !== 'pulling') return false;
  job.status = 'cancelled';
  job.detail = 'cancelled';
  job.finishedAt = Date.now();
  pullAborts.get(key)?.abort();
  pullAborts.delete(key);
  return true;
}

async function consumePullStream(job: PullJob, res: Response, key: string): Promise<void> {
  try {
    if (!res.ok || !res.body) {
      // A 400/404 here almost always means the model ref doesn't exist in the
      // registry (or was mistyped) — give that, not a bare status code.
      if (res.status === 400 || res.status === 404) {
        throw new Error(
          `Ollama couldn't find "${job.model}" — check the model name (lowercase, no spaces; e.g. qwen3:8b, qwen3:14b).`,
        );
      }
      throw new Error(`Ollama /api/pull returned ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as { status?: string; error?: string; completed?: number; total?: number };
          if (ev.error) throw new Error(ev.error);
          if (ev.status) job.detail = ev.status;
          // Ollama reports per-layer progress; the largest layer dominates,
          // so tracking the max total seen gives a stable overall bar.
          if (typeof ev.total === 'number' && ev.total >= job.total) {
            job.total = ev.total;
            job.completed = ev.completed ?? job.completed;
          }
        } catch (err) {
          if (err instanceof SyntaxError) continue; // torn NDJSON line
          throw err;
        }
      }
    }
    if (!/success/i.test(job.detail)) {
      // Stream ended without Ollama's terminal "success" status.
      throw new Error(`pull stream ended early (last status: ${job.detail})`);
    }
    job.status = 'success';
  } catch (err) {
    // A cancel aborts the socket, which surfaces here as a read error. That is
    // the expected end of a cancelled pull, not a fault: leave the status and
    // timestamp cancelPull already set, or the UI reports "failed" for an
    // outcome the operator chose deliberately.
    if (job.status === 'cancelled') return;
    job.status = 'error';
    job.error = err instanceof Error ? err.message : String(err);
  } finally {
    pullAborts.delete(key);
    if (job.status !== 'cancelled') job.finishedAt = Date.now();
  }
}

/** A chain step: a spawned command, or an in-process callback (with a log label).
 *  Callbacks may be async — the chain awaits a returned promise. */
export type InstallStep =
  | { run: [string, string[]]; env?: Record<string, string> }
  | { call: () => void | Promise<void>; label: string };

/**
 * Child env for a chain step. The service PATH frequently omits the directory of
 * the node that's running us — mise/nvm/asdf/Volta install node (and its bundled
 * pnpm/corepack) under a versioned dir that systemd's own PATH never lists — so a
 * bare `spawn('pnpm', …)` dies with `spawn pnpm ENOENT`. pnpm ships alongside that
 * node, so splice its dir onto PATH for every step and its own children (e.g.
 * `container/build.sh`'s pnpm/node calls). Step-specific env still layers on top.
 */
function installChainEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  const nodeDir = path.dirname(process.execPath);
  const parts = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (!parts.includes(nodeDir)) env.PATH = [nodeDir, ...parts].join(path.delimiter);
  return env;
}

/**
 * Run installer steps in sequence, streaming a capped rolling log into `state`.
 * Stops on the first non-zero exit or thrown callback. Shared by the roster
 * refresh and the routing install so the spawn/log boilerplate lives once.
 */
function runInstallChain(state: InstallState, steps: InstallStep[], root: string): void {
  // Line-buffered append. Chunks rarely align with lines: progress output
  // (health-check dots, docker/ollama status) arrives newline-free or
  // \r-separated. An unterminated tail is held as `partial` and rendered as a
  // mutable last line — so a dot stream reads "....." growing in place instead
  // of one single-dot line per chunk. \r counts as a line break so in-place
  // progress rewrites surface as their latest state.
  let partial = '';
  let partialShown = false;
  const append = (chunk: Buffer | string): void => {
    const parts = (partial + String(chunk)).split(/\r\n|\n|\r/);
    partial = parts.pop() ?? '';
    if (partialShown) {
      state.lines.pop();
      partialShown = false;
    }
    for (const l of parts) {
      const line = l.trimEnd();
      if (!line) continue;
      state.lines.push(line);
    }
    if (partial.trimEnd()) {
      state.lines.push(partial.trimEnd());
      partialShown = true;
    }
    while (state.lines.length > LINES_CAP) state.lines.shift();
  };
  // Finalize any partial at a step boundary so the next step's header can't
  // pop-and-merge into real output from the previous one.
  const flush = (): void => {
    partial = '';
    partialShown = false;
  };
  const fail = (code: number): void => {
    state.running = false;
    state.exitCode = code;
    state.finishedAt = Date.now();
  };
  const runStep = (i: number): void => {
    if (i >= steps.length) {
      state.running = false;
      state.exitCode = 0;
      state.finishedAt = Date.now();
      return;
    }
    const step = steps[i];
    if ('call' in step) {
      append(`→ ${step.label} …
`);
      Promise.resolve()
        .then(() => step.call())
        .then(() => runStep(i + 1))
        .catch((err: unknown) => {
          append(`✗ ${err instanceof Error ? err.message : String(err)}
`);
          fail(1);
        });
      return;
    }
    const [cmd, args] = step.run;
    append(`→ ${args[0].split('/').slice(-1)[0]} …\n`);
    // A step may carry extra env (e.g. a secret token) — merged over the parent
    // so it reaches the child WITHOUT ever appearing in the streamed log or args.
    const child = spawn(cmd, args, { cwd: root, env: installChainEnv(step.env) });
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    // A missing binary (ENOENT — e.g. node/pnpm not on the service PATH) emits
    // 'error', not 'close'. Without this listener it becomes an uncaughtException
    // → process.exit(1), taking down the whole host on one install click.
    let closed = false;
    child.on('error', (err) => {
      if (closed) return;
      closed = true;
      append(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
      flush();
      fail(1);
    });
    child.on('close', (code) => {
      if (closed) return; // 'error' already finalized this step
      closed = true;
      flush();
      if (code !== 0) return fail(code ?? 1);
      runStep(i + 1);
    });
  };
  runStep(0);
}

/** Idempotent KEY=VALUE upsert into .env (mirrors the installers' set_env). */
export function upsertEnv(root: string, key: string, val: string): void {
  const envFile = path.join(root, '.env');
  // Strip CR/LF so a value can never inject an extra KEY=value line (e.g. a
  // crafted ElevenLabs key rebinding WEBCHAT_HOST). Keys here are constants.
  const safeVal = String(val).replace(/[\r\n]/g, '');
  let raw = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  raw = raw
    .split('\n')
    .filter((l) => !l.startsWith(`${key}=`))
    .join('\n');
  if (raw && !raw.endsWith('\n')) raw += '\n';
  fs.writeFileSync(envFile, raw + `${key}=${safeVal}\n`, { mode: 0o600 });
  // mode only applies on create; force 0600 on the (usual) pre-existing file so
  // WEBCHAT_STT_API_KEY never lands in a group/world-readable .env.
  try {
    fs.chmodSync(envFile, 0o600);
  } catch {
    /* best-effort; non-fatal on platforms without chmod semantics */
  }
}
// ── Tailscale install (one-click from the wizard Access step) ───────────────
// Only offered where it can actually succeed: tailscaled needs /dev/net/tun (an
// unprivileged Proxmox LXC only has it if the host passes it through) and the
// install + sign-in need root. When those don't hold, the UI points at the
// Proxmox community helper (which does the host-side TUN setup) instead.
const tailscaleInstallState: InstallState = {
  running: false,
  lines: [],
  exitCode: null,
  startedAt: null,
  finishedAt: null,
};

export interface TailscaleInstallState extends InstallState {
  /** /dev/net/tun is present — the kernel device tailscaled needs. */
  tunPresent: boolean;
  /** The host process is root — the installer + `tailscale up` require it. */
  isRoot: boolean;
  /** Both hold, so a one-click install can bring Tailscale up here. */
  canInstall: boolean;
}

export function getTailscaleInstallState(): TailscaleInstallState {
  const tunPresent = fs.existsSync('/dev/net/tun');
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  return { ...tailscaleInstallState, tunPresent, isRoot, canInstall: tunPresent && isRoot };
}

// Distro-aware, signed-repo Tailscale install (no curl|sh). Debian/Ubuntu via
// apt with the GPG-verified keyring; RHEL/Fedora via dnf/yum repo. Everything
// is apt/dnf-verified; the only network trust is the static signing key, after
// which package signatures are checked. Refuses on unknown package managers.
const TAILSCALE_PKG_INSTALL = [
  'set -e',
  'if command -v tailscale >/dev/null 2>&1; then echo "tailscale already installed"; exit 0; fi',
  '. /etc/os-release',
  'if command -v apt-get >/dev/null 2>&1; then',
  '  install -m 0755 -d /usr/share/keyrings',
  '  curl -fsSL "https://pkgs.tailscale.com/stable/${ID}/${VERSION_CODENAME}.noarmor.gpg" -o /usr/share/keyrings/tailscale-archive-keyring.gpg',
  '  curl -fsSL "https://pkgs.tailscale.com/stable/${ID}/${VERSION_CODENAME}.tailscale-keyring.list" -o /etc/apt/sources.list.d/tailscale.list',
  '  apt-get update',
  '  apt-get install -y tailscale',
  'elif command -v dnf >/dev/null 2>&1; then',
  "  dnf install -y 'dnf-command(config-manager)'",
  '  dnf config-manager --add-repo "https://pkgs.tailscale.com/stable/${ID}/${VERSION_ID}/tailscale.repo"',
  '  dnf install -y tailscale',
  '  systemctl enable --now tailscaled',
  'elif command -v yum >/dev/null 2>&1; then',
  '  yum install -y yum-utils',
  '  yum-config-manager --add-repo "https://pkgs.tailscale.com/stable/${ID}/${VERSION_ID}/tailscale.repo"',
  '  yum install -y tailscale',
  '  systemctl enable --now tailscaled',
  'else',
  '  echo "No supported package manager (apt/dnf/yum). Install Tailscale manually (https://tailscale.com/download), then re-run." >&2',
  '  exit 1',
  'fi',
].join('\n');

export interface StartInstallResult {
  started: boolean;
  error?: 'already-running' | 'not-supported' | 'prereq-missing';
}

export function startTailscaleInstall(root = process.cwd()): StartInstallResult {
  if (tailscaleInstallState.running) return { started: false, error: 'already-running' };
  if (!getTailscaleInstallState().canInstall) return { started: false, error: 'prereq-missing' };
  tailscaleInstallState.running = true;
  tailscaleInstallState.lines = [];
  tailscaleInstallState.exitCode = null;
  tailscaleInstallState.startedAt = Date.now();
  tailscaleInstallState.finishedAt = null;
  const steps: InstallStep[] = [
    // Install tailscaled from Tailscale's SIGNED package repo (apt/dnf/yum),
    // not `curl … | sh`. apt/dnf verify the GPG-signed keyring + package, so a
    // MITM'd or compromised endpoint can't inject arbitrary root code the way a
    // piped install script can. Idempotent (no-ops if already present); refuses
    // on distros without a known package manager rather than falling back to a
    // pipe-to-shell. The keyring/repo URLs are the ones Tailscale's own
    // installer configures.
    { run: ['bash', ['-c', TAILSCALE_PKG_INSTALL]] },
    // Bring it up; `tailscale up` prints the sign-in URL to the log for the operator
    // to open, and returns once they authenticate. A 10-minute cap keeps a
    // never-completed sign-in from hanging the chain forever.
    { run: ['bash', ['-c', 'timeout 600 tailscale up --accept-dns=false']] },
  ];
  runInstallChain(tailscaleInstallState, steps, root);
  return { started: true };
}
// ── Local Ollama install (wizard) ──────────────────────────────────────────
// Rootless install: the host service runs unprivileged, so the official
// `install.sh` (which sudo-installs to /usr/local + system systemd) is out.
// Instead: official release tarball → ~/.local, a systemd --user unit, and
// `enable --now`. Matches how a rootless operator installs by hand and needs
// no credentials. Linux-only; other platforms get a manual hint.
const ollamaInstallState: InstallState = {
  running: false,
  lines: [],
  exitCode: null,
  startedAt: null,
  finishedAt: null,
};

const OLLAMA_INSTALL_SCRIPT = `
set -e
arch=$(uname -m)
case "$arch" in
  x86_64) pkg=ollama-linux-amd64.tar.zst ;;
  aarch64) pkg=ollama-linux-arm64.tar.zst ;;
  *) echo "unsupported arch: $arch" >&2; exit 1 ;;
esac
command -v zstd >/dev/null || { echo "zstd is required to unpack Ollama — install it (apt/pacman install zstd) and retry" >&2; exit 1; }
url="https://github.com/ollama/ollama/releases/latest/download/$pkg"
# Resolve HOME — a system-service/root context (an LXC, say) often runs with it
# unset, which would otherwise install to /.local and break every unit path.
[ -n "$HOME" ] || HOME=$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)
[ -n "$HOME" ] || HOME=/root
export HOME
mkdir -p "$HOME/.local"
# STABLE path (not mktemp) + curl -C - so a reconnect / re-run RESUMES the
# ~1.4GB download instead of restarting it. GitHub's CDN honours range requests;
# du reports cumulative bytes so the progress line keeps counting up. No
# delete-on-exit trap — a partial must survive to be resumed; it's removed only
# after a successful extract below.
tmp="/tmp/ollama-dl-$arch.tar.zst"
total=$(curl -sIL --max-time 15 "$url" | tr -d "\r" | awk 'tolower($1)=="content-length:"{s=$2} END{print int(s/1048576)}')
echo "downloading $url (~\${total:-?} MB, resuming if partial) …"
curl -fSL -C - --no-progress-meter -o "$tmp" "$url" &
dl=$!
while kill -0 "$dl" 2>/dev/null; do
  sleep 5
  echo "downloaded $(du -m "$tmp" 2>/dev/null | cut -f1) of \${total:-?} MB …"
done
wait "$dl"
echo "extracting …"
tar --zstd -xf "$tmp" -C "$HOME/.local"
rm -f "$tmp"
bin="$HOME/.local/bin/ollama"
echo "installed to $bin"
# HOME is passed explicitly: a system unit runs with it unset, and \`ollama serve\`
# resolves its model dir from $HOME/.ollama — unset would send it to /.ollama and
# it can crash on start. (Same unset-HOME class as the host's own service unit.)
write_unit() { printf '[Unit]\\nDescription=%s\\nAfter=network-online.target\\n\\n[Service]\\nExecStart=%s serve\\nRestart=always\\nEnvironment=OLLAMA_HOST=0.0.0.0\\nEnvironment=HOME=%s\\n\\n[Install]\\nWantedBy=%s\\n' "$1" "$2" "$HOME" "$3"; }
# Register a service the way that actually works in THIS context:
#   1) a user systemd session (rootless dev host)    -> systemctl --user
#   2) system systemd as root (LXC / system service) -> /etc/systemd/system
#   3) nothing reachable                             -> nohup fallback
if [ -n "$XDG_RUNTIME_DIR" ] && systemctl --user show-environment >/dev/null 2>&1; then
  echo "registering ollama as a user service …"
  mkdir -p "$HOME/.config/systemd/user"
  write_unit "Ollama Service (rootless)" "$bin" default.target > "$HOME/.config/systemd/user/ollama.service"
  systemctl --user daemon-reload
  systemctl --user enable --now ollama.service
elif [ "$(id -u)" = 0 ] && command -v systemctl >/dev/null 2>&1; then
  echo "registering ollama as a system service …"
  write_unit "Ollama Service" "$bin" multi-user.target > /etc/systemd/system/ollama.service
  systemctl daemon-reload
  systemctl enable --now ollama.service
else
  echo "no systemd session — starting ollama with nohup …"
  OLLAMA_HOST=0.0.0.0 nohup "$bin" serve >/tmp/ollama.log 2>&1 &
fi
echo "waiting for Ollama to come up …"
for i in $(seq 1 60); do
  curl -sf http://127.0.0.1:11434/api/tags >/dev/null && { echo "Ollama is running."; exit 0; }
  sleep 1
done
echo "Ollama did not answer on :11434 after 60s" >&2
# Type=simple reports "started" the instant the binary is exec'd, so a crash a
# moment later still looks like a clean start — surface the unit's own status and
# recent log so the failure is diagnosable instead of a bare timeout.
if [ -n "$XDG_RUNTIME_DIR" ] && systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user status ollama.service --no-pager -l 2>&1 | tail -n 12 >&2 || true
  journalctl --user -u ollama.service -n 20 --no-pager 2>&1 | tail -n 20 >&2 || true
elif [ "$(id -u)" = 0 ] && command -v systemctl >/dev/null 2>&1; then
  systemctl status ollama.service --no-pager -l 2>&1 | tail -n 12 >&2 || true
  journalctl -u ollama.service -n 20 --no-pager 2>&1 | tail -n 20 >&2 || true
else
  tail -n 20 /tmp/ollama.log 2>/dev/null >&2 || true
fi
exit 1
`;

export interface OllamaLocalState {
  reachable: boolean;
  canInstall: boolean;
  running: boolean;
  lines: string[];
  exitCode: number | null;
}

/** Local-Ollama status for the wizard: is :11434 answering, can we install here? */
export async function getOllamaLocalState(): Promise<OllamaLocalState> {
  let reachable = false;
  try {
    const r = await safeFetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1500) });
    reachable = r.ok;
  } catch {
    /* not running */
  }
  return {
    reachable,
    canInstall: process.platform === 'linux',
    running: ollamaInstallState.running,
    lines: ollamaInstallState.lines.slice(-20),
    exitCode: ollamaInstallState.exitCode,
  };
}

export function startOllamaInstall(): { started: boolean; error?: string } {
  if (ollamaInstallState.running) return { started: false, error: 'already-running' };
  if (process.platform !== 'linux')
    return { started: false, error: 'Automatic install is Linux-only — install Ollama from ollama.com manually.' };
  ollamaInstallState.running = true;
  ollamaInstallState.lines = [];
  ollamaInstallState.exitCode = null;
  ollamaInstallState.startedAt = Date.now();
  ollamaInstallState.finishedAt = null;
  runInstallChain(ollamaInstallState, [{ run: ['sh', ['-c', OLLAMA_INSTALL_SCRIPT]] }], process.cwd());
  return { started: true };
}

/**
 * The service-restart command for the current runtime context — pure, so the
 * per-context branching (the part that can't be live-exercised here) is unit
 * tested. macOS uses launchd; Linux uses the user systemd session when one
 * exists (rootless dev host), falling back to the system unit (LXC / root).
 *
 * Linux uses `systemd-run` so the restart runs as a transient unit owned by the
 * systemd MANAGER, not as a child of this process. A service restarting ITSELF
 * with a plain `systemctl restart` is fragile: the child issuing it lives in the
 * unit's cgroup, and `KillMode=control-group` (the default) SIGKILLs the whole
 * cgroup on stop — so the restarter can die before the restart is even enqueued,
 * leaving the OLD process running (the "machine's up but the service never
 * reloaded, so the new provider never registers" bug). A transient unit is
 * detached from that cgroup and survives the teardown. Falls back to a bare
 * `systemctl restart` where systemd-run isn't available.
 */
export function providerRestartCommand(opts: {
  platform: NodeJS.Platform;
  hasUserSession: boolean;
  unit: string;
  label: string;
}): string {
  if (opts.platform === 'darwin') return `launchctl kickstart -k gui/$(id -u)/${opts.label}`;
  if (opts.hasUserSession) {
    return (
      `systemd-run --user --quiet --collect systemctl --user restart ${opts.unit} 2>/dev/null || ` +
      `systemd-run --quiet --collect systemctl restart ${opts.unit} 2>/dev/null || ` +
      `systemctl --user restart ${opts.unit} 2>/dev/null || systemctl restart ${opts.unit}`
    );
  }
  return `systemd-run --quiet --collect systemctl restart ${opts.unit} 2>/dev/null || systemctl restart ${opts.unit}`;
}

/**
 * The systemd unit this process is actually running under, read from its own
 * cgroup. `getSystemdUnit()` computes the name a *fresh setup* would register
 * (`nanoclaw-v2-<slug>`), but other installers name it differently — the Proxmox
 * community/deploy path uses a plain `nanoclaw.service`. Restarting the computed
 * name then hits a unit that doesn't exist and silently no-ops, so the service
 * never reloads (the "Codex installed but never activates" bug). Reading the live
 * cgroup makes the restart target whatever unit we're truly under, regardless of
 * what the installer called it. Pure so it's unit-tested against real cgroup text.
 */
export function parseSystemdUnitFromCgroup(cgroup: string): string | null {
  // cgroup v2: "0::/system.slice/nanoclaw.service". A --user service nests under
  // "user@UID.service/…/<unit>.service", so the LEAF (last match) is our unit.
  let unit: string | null = null;
  for (const line of cgroup.split('\n')) {
    const matches = line.match(/[A-Za-z0-9@%:._-]+\.service/g);
    if (matches && matches.length) unit = matches[matches.length - 1];
  }
  return unit;
}

function runningSystemdUnit(): string | null {
  try {
    return parseSystemdUnitFromCgroup(fs.readFileSync('/proc/self/cgroup', 'utf8'));
  } catch {
    return null;
  }
}

export function scheduleHostRestart(): void {
  const cmd = providerRestartCommand({
    platform: process.platform,
    hasUserSession: Boolean(process.env.XDG_RUNTIME_DIR),
    // The unit we're ACTUALLY running under wins; fall back to the computed name.
    unit: runningSystemdUnit() ?? getSystemdUnit(),
    label: getLaunchdLabel(),
  });
  spawn('sh', ['-c', `sleep 2; ${cmd}`], { detached: true, stdio: 'ignore' }).unref();
}
