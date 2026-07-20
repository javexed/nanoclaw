/**
 * Backend for the webchat Models and Routing tabs (owner-only surfaces). All
 * outbound calls to operator-supplied Ollama/LiteLLM endpoints go through
 * models.ts's safeFetch SSRF gate.
 *
 * Ollama host management (Models tab):
 *   - listHostModels(host)   — installed models (/api/tags) merged with what's
 *     loaded and its VRAM split (/api/ps).
 *   - Pull manager           — start a streamed pull (/api/pull, NDJSON) and
 *     expose progress snapshots the client polls. One active pull per
 *     host+model; finished jobs linger ~10 min for reconnecting clients.
 *   - Roster refresh         — re-run the /add-litellm installer (+ /add-routing
 *     layer when present) so a freshly pulled model becomes routable. Shells out
 *     to the skill's own installer; reports {available:false} when the skill
 *     isn't installed so the UI can hide the button. Skills are referenced by
 *     path at runtime, never imported.
 *
 * LiteLLM router / classifier (Routing tab), all guarded by the routing skill
 * being present (routes.json / capabilities.json):
 *   - getRouterInfo / getRouterMetrics — the roster and the dashboard traffic
 *     panel (from the routing decision log).
 *   - Routes config CRUD (readRoutesConfig / mergeRoutesUpdate / writeRoutesConfig)
 *     — the operator-editable routes; the classifier section is never
 *     client-writable.
 *   - dryClassify            — run the real classifier on a prompt, change nothing
 *     (the "test a prompt" bench). Prompt contract KEEP-IN-SYNC with router_hook.py.
 *   - getRouteSuggestions / computeRouteSuggestions + readCapabilityCatalog —
 *     propose a route for a roster capability nothing covers yet.
 *   - recentDecisions        — tail the routing decision log for the Logs sub-tab.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { safeFetch } from './models.js';
import { listWebchatModels } from './db.js';
import { getSystemdUnit, getLaunchdLabel } from '../../install-slug.js';

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
  status: 'pulling' | 'success' | 'error';
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
  pulls.clear();
}

/**
 * Start a pull. Returns the job (existing one if the same pull is already
 * running — pressing the button twice must not start two downloads).
 */
export async function startPull(host: string, model: string): Promise<PullJob> {
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

  // Validate the endpoint (SSRF gate) BEFORE returning, so a blocked URL is
  // a synchronous 4xx for the caller instead of a background failure.
  // No overall timeout on the stream itself: model pulls legitimately run
  // for many minutes (the curl --max-time lesson).
  let res: Response;
  try {
    res = await safeFetch(`${job.host}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
    });
  } catch (err) {
    job.status = 'error';
    job.error = err instanceof Error ? err.message : String(err);
    job.finishedAt = Date.now();
    throw err;
  }

  void consumePullStream(job, res);
  return job;
}

async function consumePullStream(job: PullJob, res: Response): Promise<void> {
  try {
    if (!res.ok || !res.body) {
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
    job.status = 'error';
    job.error = err instanceof Error ? err.message : String(err);
  } finally {
    job.finishedAt = Date.now();
  }
}

// ── Roster refresh (LiteLLM + routing layer) ───────────────────────────────

export interface RosterRefreshState {
  available: boolean;
  running: boolean;
  /** Rolling tail of installer output (capped). */
  lines: string[];
  exitCode: number | null;
  startedAt: number | null;
  finishedAt: number | null;
}

const LINES_CAP = 200;

const refreshState: RosterRefreshState = {
  available: false,
  running: false,
  lines: [],
  exitCode: null,
  startedAt: null,
  finishedAt: null,
};

function litellmInstallerPath(root: string): string {
  return path.join(root, '.claude/skills/add-litellm/resources/install-litellm.sh');
}
function routingInstallerPath(root: string): string {
  return path.join(root, '.claude/skills/add-routing/resources/install-routing.sh');
}
function bindRoutesPath(root: string): string {
  return path.join(root, '.claude/skills/add-routing/resources/bind-routes.mjs');
}

/** Hosts the current router config was generated from (gen-config's header). */
export function parseConfiguredHosts(configText: string): string | null {
  const m = configText.match(/^# hosts:\s*(.+)$/m);
  if (!m) return null;
  const hosts = m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return hosts.length > 0 ? hosts.join(',') : null;
}

/**
 * Model-server hosts for `install-litellm --hosts`, so a fresh routing install
 * points LiteLLM at the operator's ACTUAL model servers (often a remote/LAN
 * Ollama) instead of defaulting to a non-existent localhost. Priority:
 *   1. An existing config.yaml `# hosts:` header — reuse what's already wired.
 *   2. The roster's Ollama endpoints (distinct) — the servers the operator
 *      registered. LiteLLM's own proxy (an openai-compatible row) is never a
 *      model server, so those are skipped (they'd be circular).
 * Returns null when nothing is known; the caller then keeps install-litellm's
 * localhost default (which yields its clear "no model server reachable" hint).
 */
export function deriveModelServerHosts(root = process.cwd()): string | null {
  const configPath = path.join(root, 'data/litellm/config.yaml');
  if (fs.existsSync(configPath)) {
    const fromConfig = parseConfiguredHosts(fs.readFileSync(configPath, 'utf8'));
    if (fromConfig) return fromConfig;
  }
  try {
    const seen = new Set<string>();
    for (const m of listWebchatModels()) {
      if (m.kind !== 'ollama' || !m.endpoint) continue;
      const host = m.endpoint.replace(/\/+$/, '');
      if (host) seen.add(host);
    }
    return seen.size > 0 ? [...seen].join(',') : null;
  } catch {
    return null;
  }
}

export function getRosterRefreshState(root = process.cwd()): RosterRefreshState {
  refreshState.available =
    fs.existsSync(litellmInstallerPath(root)) && fs.existsSync(path.join(root, 'data/litellm/config.yaml'));
  return refreshState;
}

/** The subset of installer state the shared runner drives (a rolling log job). */
interface InstallState {
  running: boolean;
  lines: string[];
  exitCode: number | null;
  startedAt: number | null;
  finishedAt: number | null;
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

/**
 * Re-run the litellm installer with the hosts the current config was built
 * from, then the routing layer's installer when its hook is installed
 * (the documented ordering: add-litellm first, then add-routing).
 * One refresh at a time; returns false when one is already running or the
 * skill isn't installed.
 */
export function startRosterRefresh(root = process.cwd()): boolean {
  if (refreshState.running) return false;
  const installer = litellmInstallerPath(root);
  const configPath = path.join(root, 'data/litellm/config.yaml');
  if (!fs.existsSync(installer) || !fs.existsSync(configPath)) return false;
  const hosts = parseConfiguredHosts(fs.readFileSync(configPath, 'utf8'));
  if (hosts === null) {
    refreshState.lines = ['config.yaml has no "# hosts:" header — re-run the /add-litellm installer by hand once.'];
    return false;
  }

  refreshState.running = true;
  refreshState.lines = [];
  refreshState.exitCode = null;
  refreshState.startedAt = Date.now();
  refreshState.finishedAt = null;

  const steps: InstallStep[] = [{ run: ['bash', [installer, '--hosts', hosts]] }];
  if (fs.existsSync(path.join(root, 'data/litellm/router_hook.py')) && fs.existsSync(routingInstallerPath(root))) {
    steps.push({ run: ['bash', [routingInstallerPath(root)]] });
  }
  // Capability auto-binding: a refreshed roster re-binds unpinned routes so a
  // freshly pulled model joins routing on its own (see the routing skill's
  // bind-routes.mjs — pins, escalate, and descriptions are never touched).
  if (fs.existsSync(bindRoutesPath(root))) {
    steps.push({ run: ['node', [bindRoutesPath(root), '--apply']] });
  }
  runInstallChain(refreshState, steps, root);
  return true;
}

// ── Routing install (one-click "Set up routing" from Settings) ─────────────

const ARCH_ROUTER_MODEL = 'hf.co/katanemo/Arch-Router-1.5B.gguf:Q4_K_M';

const routingInstallState: InstallState = {
  running: false,
  lines: [],
  exitCode: null,
  startedAt: null,
  finishedAt: null,
};

export interface RoutingInstallState extends InstallState {
  /** routes.json exists — routing is scaffolded and the Routing tab can show. */
  installed: boolean;
  /** The LiteLLM router is installed (add-litellm ran) — routing's prerequisite. */
  litellmReady: boolean;
  /** The Arch-Router classifier download, if one has been kicked off. */
  pull: PullJob | null;
}

export function getRoutingInstallState(root = process.cwd()): RoutingInstallState {
  const pull = getPullsSnapshot().find((j) => j.model === ARCH_ROUTER_MODEL) ?? null;
  return {
    ...routingInstallState,
    installed: fs.existsSync(routesPathFor(root)),
    litellmReady: fs.existsSync(path.join(root, 'data/litellm/config.yaml')),
    pull,
  };
}

/**
 * Point the seeded classifier at the real Ollama host. router_hook.py runs
 * INSIDE the LiteLLM container, so the host is `host.docker.internal`, not
 * `localhost` (the roster path uses the same form). Idempotent — only the
 * install seed's `CLASSIFIER-HOST` placeholder is rewritten, never an
 * operator-set host. mergeRoutesUpdate refuses to touch `classifier`, so this
 * is the one place that owns it.
 */
function configureClassifierHost(root: string): void {
  const cfg = readRoutesConfig(root);
  if (!cfg) throw new Error('routes.json not found after install');
  const classifier = (cfg.classifier ?? {}) as Record<string, unknown>;
  const url = typeof classifier.url === 'string' ? classifier.url : '';
  if (url.includes('CLASSIFIER-HOST')) {
    classifier.url = url.replace('CLASSIFIER-HOST', 'host.docker.internal');
    cfg.classifier = classifier;
    writeRoutesConfig(cfg, root);
  }
}

export interface StartRoutingResult {
  started: boolean;
  error?: 'already-running' | 'litellm-not-installed' | 'installer-missing' | 'prereq-missing';
}

/**
 * One-click routing setup: kick the Arch-Router classifier pull (streamed via
 * the normal pull machinery, in parallel), then run install-routing.sh → point
 * the classifier at the host → auto-bind routes to the roster. Shadow mode by
 * default (the template's `live.enabled:false`). One install at a time.
 */
export function startRoutingInstall(root = process.cwd()): StartRoutingResult {
  if (routingInstallState.running) return { started: false, error: 'already-running' };
  const configPath = path.join(root, 'data/litellm/config.yaml');
  if (!fs.existsSync(configPath)) return { started: false, error: 'litellm-not-installed' };
  if (!fs.existsSync(routingInstallerPath(root)) || !fs.existsSync(bindRoutesPath(root))) {
    return { started: false, error: 'installer-missing' };
  }

  // Kick the classifier-model pull in parallel on the host-side Ollama. The
  // install steps don't wait on it — the model is only needed at classify time.
  const ollamaHost =
    parseConfiguredHosts(fs.readFileSync(configPath, 'utf8'))?.split(',')[0] ?? 'http://localhost:11434';
  void startPull(ollamaHost, ARCH_ROUTER_MODEL).catch(() => {
    /* failure surfaces on the pull job's own status/error */
  });

  routingInstallState.running = true;
  routingInstallState.lines = [];
  routingInstallState.exitCode = null;
  routingInstallState.startedAt = Date.now();
  routingInstallState.finishedAt = null;

  const steps: InstallStep[] = [
    { run: ['bash', [routingInstallerPath(root)]] },
    { call: () => configureClassifierHost(root), label: 'configure classifier host' },
    { run: ['node', [bindRoutesPath(root), '--apply']] },
  ];
  runInstallChain(routingInstallState, steps, root);
  return { started: true };
}

// ── Read-aloud (Kokoro TTS) install — one-click from Settings ───────────────
// Same chain machinery as routing: the /add-webchat-tts skill's installer does
// the real work (pinned loopback-only container + .env flags + health check,
// which covers the ~330MB first-boot model download). A final step loads the
// written WEBCHAT_TTS_* keys into THIS process so the feature goes live with
// no host restart.

const ttsInstallState: InstallState = {
  running: false,
  lines: [],
  exitCode: null,
  startedAt: null,
  finishedAt: null,
};

function ttsInstallerPath(root: string): string {
  return path.join(root, '.claude/skills/add-webchat-tts/resources/install-kokoro.sh');
}

export interface TtsInstallState extends InstallState {
  /** Server-side synthesis is configured and live in this process. */
  installed: boolean;
  /** The /add-webchat-tts installer is present in this checkout. */
  installerPresent: boolean;
}

/**
 * Is the TTS (Kokoro) backend actually answering? A plain loopback fetch — the
 * endpoint is operator-configured and local, same as the synthesis proxy in
 * tts.ts (no SSRF gate). Any HTTP response means it's up; a refused connection
 * means it isn't. `installed` uses this instead of trusting WEBCHAT_TTS_ENABLED
 * alone, which can be stale (a persisted .env, a stopped container) and would
 * otherwise make the badge claim voice models that aren't there.
 */
async function ttsBackendUp(): Promise<boolean> {
  const base = (process.env.WEBCHAT_TTS_ENDPOINT || 'http://127.0.0.1:8880').replace(/\/+$/, '');
  try {
    const r = await fetch(base, { signal: AbortSignal.timeout(1500) });
    return r.status > 0;
  } catch {
    return false;
  }
}

export async function getTtsInstallState(root = process.cwd()): Promise<TtsInstallState> {
  const flagOn = process.env.WEBCHAT_TTS_ENABLED === 'true';
  return {
    ...ttsInstallState,
    installed: flagOn && (await ttsBackendUp()),
    installerPresent: fs.existsSync(ttsInstallerPath(root)),
  };
}

/** Load the installer-written WEBCHAT_TTS_* keys into the running process. */
function activateTtsEnv(root: string): void {
  const envFile = path.join(root, '.env');
  const raw = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  for (const key of ['WEBCHAT_TTS_ENABLED', 'WEBCHAT_TTS_ENDPOINT', 'WEBCHAT_TTS_MODEL', 'WEBCHAT_TTS_VOICE']) {
    const m = raw.match(new RegExp(`^${key}=(.*)$`, 'm'));
    if (m) process.env[key] = m[1].trim();
  }
}

export function startTtsInstall(root = process.cwd()): StartRoutingResult {
  if (ttsInstallState.running) return { started: false, error: 'already-running' };
  if (!fs.existsSync(ttsInstallerPath(root))) return { started: false, error: 'installer-missing' };

  ttsInstallState.running = true;
  ttsInstallState.lines = [];
  ttsInstallState.exitCode = null;
  ttsInstallState.startedAt = Date.now();
  ttsInstallState.finishedAt = null;

  const steps: InstallStep[] = [
    { run: ['bash', [ttsInstallerPath(root)]] },
    { call: () => activateTtsEnv(root), label: 'activate (no restart needed)' },
  ];
  runInstallChain(ttsInstallState, steps, root);
  return { started: true };
}

// ── Voice-dictation (STT) install — Settings → Features → Voice dictation ──
// Local (recommended): the /add-webchat-dictation skill's installer provisions
// a pinned whisper.cpp container on loopback with a hardware-suggested, pinned
// ggml model. Cloud (explicit opt-in): ElevenLabs — no container, just a key
// probe + .env write. Either way a final step loads the WEBCHAT_STT_* keys
// into THIS process so the mic goes live with no host restart.

const sttInstallState: InstallState = {
  running: false,
  lines: [],
  exitCode: null,
  startedAt: null,
  finishedAt: null,
};

function sttInstallerPath(root: string): string {
  return path.join(root, '.claude/skills/add-webchat-dictation/resources/install-whisper.sh');
}

/** Whisper model sizes offered at install (multilingual + .en speed variants). */
export const STT_MODELS = ['tiny', 'tiny.en', 'base', 'base.en', 'small', 'small.en', 'medium', 'medium.en'];

/**
 * Same rules as the Ollama install: probe hardware, suggest a size.
 * GPU or a big box → small; mid → base; small → tiny. Multilingual by default.
 */
export function suggestSttModel(): string {
  const cores = os.cpus().length;
  const memGb = os.totalmem() / 1024 / 1024 / 1024;
  let hasGpu = false;
  try {
    hasGpu = fs.existsSync('/dev/nvidia0');
  } catch {
    /* no GPU probe on this platform */
  }
  if (hasGpu || (cores >= 8 && memGb >= 15)) return 'small';
  if (cores >= 4 && memGb >= 7) return 'base';
  return 'tiny';
}

export interface SttInstallState extends InstallState {
  /** A backend is provisioned (env config present) — independent of the toggle. */
  installed: boolean;
  /** Workspace toggle: the mic is on for everyone. */
  enabled: boolean;
  /** Which backend the env is configured for (meaningful when installed). */
  provider: string;
  /** Current transcription model (env truth; null before first install). */
  model: string | null;
  /** The /add-webchat-dictation installer is present in this checkout. */
  installerPresent: boolean;
  /** Hardware-suggested default for the model select. */
  suggestedModel: string;
  models: string[];
}

export function getSttInstallState(root = process.cwd()): SttInstallState {
  return {
    ...sttInstallState,
    installed: Boolean(
      process.env.WEBCHAT_STT_URL ||
      (process.env.WEBCHAT_STT_PROVIDER === 'elevenlabs' && process.env.WEBCHAT_STT_API_KEY),
    ),
    enabled: process.env.WEBCHAT_STT_ENABLED === 'true',
    provider: process.env.WEBCHAT_STT_PROVIDER || 'local',
    model: process.env.WEBCHAT_STT_MODEL || null,
    installerPresent: fs.existsSync(sttInstallerPath(root)),
    suggestedModel: suggestSttModel(),
    models: STT_MODELS,
  };
}

const STT_ENV_KEYS = [
  'WEBCHAT_STT_ENABLED',
  'WEBCHAT_STT_PROVIDER',
  'WEBCHAT_STT_URL',
  'WEBCHAT_STT_MODEL',
  'WEBCHAT_STT_LANG',
  'WEBCHAT_STT_API_KEY',
];

/** Load the installer-written WEBCHAT_STT_* keys into the running process. */
function activateSttEnv(root: string): void {
  const envFile = path.join(root, '.env');
  const raw = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  for (const key of STT_ENV_KEYS) {
    const m = raw.match(new RegExp(`^${key}=(.*)$`, 'm'));
    if (m) process.env[key] = m[1].trim();
  }
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

export interface StartSttOptions {
  provider: 'local' | 'elevenlabs';
  /** local only — one of STT_MODELS; defaults to the hardware suggestion. */
  model?: string;
  /** elevenlabs only — validated against the provider before anything is written. */
  apiKey?: string;
}

export interface StartSttResult {
  started: boolean;
  error?: 'already-running' | 'installer-missing' | 'bad-model' | 'missing-key';
}

export function startSttInstall(opts: StartSttOptions, root = process.cwd()): StartSttResult {
  if (sttInstallState.running) return { started: false, error: 'already-running' };

  let steps: InstallStep[];
  if (opts.provider === 'elevenlabs') {
    const apiKey = (opts.apiKey ?? '').trim();
    if (!apiKey) return { started: false, error: 'missing-key' };
    steps = [
      {
        label: 'validate the ElevenLabs key',
        call: async () => {
          // Hostname fixed — the key goes to ElevenLabs and nowhere else.
          const res = await fetch('https://api.elevenlabs.io/v1/user', {
            headers: { 'xi-api-key': apiKey },
            signal: AbortSignal.timeout(10_000),
          });
          if (res.status === 401) throw new Error('ElevenLabs rejected the key (401)');
          if (!res.ok) throw new Error(`ElevenLabs answered ${res.status}`);
        },
      },
      {
        label: 'write WEBCHAT_STT_* to .env',
        call: () => {
          upsertEnv(root, 'WEBCHAT_STT_ENABLED', 'true');
          upsertEnv(root, 'WEBCHAT_STT_PROVIDER', 'elevenlabs');
          upsertEnv(root, 'WEBCHAT_STT_MODEL', 'scribe_v1');
          upsertEnv(root, 'WEBCHAT_STT_LANG', 'auto');
          upsertEnv(root, 'WEBCHAT_STT_API_KEY', apiKey);
        },
      },
      { call: () => activateSttEnv(root), label: 'activate (no restart needed)' },
    ];
  } else {
    if (!fs.existsSync(sttInstallerPath(root))) return { started: false, error: 'installer-missing' };
    const model = opts.model ?? suggestSttModel();
    if (!STT_MODELS.includes(model)) return { started: false, error: 'bad-model' };
    steps = [
      { run: ['bash', [sttInstallerPath(root), '--model', model]] },
      { call: () => activateSttEnv(root), label: 'activate (no restart needed)' },
    ];
  }

  sttInstallState.running = true;
  sttInstallState.lines = [];
  sttInstallState.exitCode = null;
  sttInstallState.startedAt = Date.now();
  sttInstallState.finishedAt = null;
  runInstallChain(sttInstallState, steps, root);
  return { started: true };
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

export function startTailscaleInstall(root = process.cwd()): StartRoutingResult {
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

// ── Cloudflare Tunnel install (one-click from the wizard Access step) ────────
// Token-driven, remotely-MANAGED tunnel: the operator creates the tunnel + its
// public hostname + an Access policy in the Cloudflare Zero Trust dashboard,
// copies the connector token, and pastes it here. We install cloudflared from
// Cloudflare's SIGNED apt repo (no curl|sh) and `cloudflared service install
// <token>`, which registers + starts the systemd service running the connector.
// Auth is enforced Cloudflare-side by the Access policy — never public-no-auth.
// The token reaches the child via env (TUNNEL_TOKEN), so it never lands in the
// streamed install log; it does persist in the service unit at rest, as the
// managed-tunnel model requires.
const cloudflaredInstallState: InstallState = {
  running: false,
  lines: [],
  exitCode: null,
  startedAt: null,
  finishedAt: null,
};

function cloudflaredPresent(): boolean {
  return ['/usr/bin/cloudflared', '/usr/local/bin/cloudflared', '/bin/cloudflared'].some((p) => fs.existsSync(p));
}
function cloudflaredServicePresent(): boolean {
  return (
    fs.existsSync('/etc/systemd/system/cloudflared.service') ||
    fs.existsSync('/etc/systemd/system/multi-user.target.wants/cloudflared.service')
  );
}

export interface CloudflaredInstallState extends InstallState {
  /** cloudflared binary present. */
  installed: boolean;
  /** The systemd connector service is registered (token-mode configured). */
  serviceInstalled: boolean;
  /** Host process is root — the install + service registration need it. */
  isRoot: boolean;
  /** systemd is PID 1 here — `cloudflared service install` registers a unit. */
  hasSystemd: boolean;
  /** Linux + root + systemd, so a one-click install can run here. cloudflared
   *  itself needs no TUN/caps (unlike tailscaled), so an unprivileged LXC with
   *  systemd + container-root qualifies — the common Proxmox case. */
  canInstall: boolean;
}

// `/run/systemd/system` exists iff the box booted with systemd as init — the
// canonical check. `cloudflared service install` needs a reachable systemd; a
// non-systemd container (Docker / minimal LXC) gets the manual-link fallback
// instead of a failing install, matching the Tailscale card's UX.
function systemdBooted(): boolean {
  return fs.existsSync('/run/systemd/system');
}

export function getCloudflaredInstallState(): CloudflaredInstallState {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const hasSystemd = systemdBooted();
  return {
    ...cloudflaredInstallState,
    installed: cloudflaredPresent(),
    serviceInstalled: cloudflaredServicePresent(),
    isRoot,
    hasSystemd,
    canInstall: process.platform === 'linux' && isRoot && hasSystemd,
  };
}

// Signed apt repo (Debian/Ubuntu — the LXC/Proxmox target). Fetches only the GPG
// key file (piped to a file, not a shell), then apt verifies the package
// signature. Idempotent; refuses on non-apt distros rather than curl|sh.
const CLOUDFLARED_PKG_INSTALL = [
  'set -e',
  'if command -v cloudflared >/dev/null 2>&1; then echo "cloudflared already installed"; exit 0; fi',
  'if command -v apt-get >/dev/null 2>&1; then',
  '  install -m 0755 -d /usr/share/keyrings',
  '  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg',
  '  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list',
  '  apt-get update',
  '  apt-get install -y cloudflared',
  'else',
  '  echo "No apt-get. Install cloudflared manually (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), then re-run." >&2',
  '  exit 1',
  'fi',
].join('\n');

export interface StartCloudflaredResult {
  started: boolean;
  error?: 'already-running' | 'prereq-missing' | 'bad-token' | 'not-installed';
}

// A connector token is a long base64url blob (a base64-encoded JSON). Reject
// empties / obviously-wrong values before spawning anything as root — not full
// validation (only Cloudflare can confirm), just a shape guard.
export function looksLikeTunnelToken(t: string): boolean {
  return /^[A-Za-z0-9+/=_-]{40,}$/.test((t || '').trim());
}

function beginCloudflared(): void {
  cloudflaredInstallState.running = true;
  cloudflaredInstallState.lines = [];
  cloudflaredInstallState.exitCode = null;
  cloudflaredInstallState.startedAt = Date.now();
  cloudflaredInstallState.finishedAt = null;
}

// Step 1 — install just the cloudflared binary (signed apt repo). No token, so
// the operator can install first, then create the tunnel + paste its token to
// connect. Idempotent (no-ops if already present).
export function startCloudflaredInstall(root = process.cwd()): StartCloudflaredResult {
  if (cloudflaredInstallState.running) return { started: false, error: 'already-running' };
  if (!getCloudflaredInstallState().canInstall) return { started: false, error: 'prereq-missing' };
  beginCloudflared();
  runInstallChain(cloudflaredInstallState, [{ run: ['bash', ['-c', CLOUDFLARED_PKG_INSTALL]] }], root);
  return { started: true };
}

// Step 2 — register + start the managed-tunnel connector from the operator's
// token. Requires cloudflared already present (step 1). The token arrives via env
// so it never reaches the streamed log; `service install` reads it as its arg.
// Reinstall-safe: drop any prior unit first (ignore failure).
export function startCloudflaredConnect(token: string, root = process.cwd()): StartCloudflaredResult {
  if (cloudflaredInstallState.running) return { started: false, error: 'already-running' };
  if (!getCloudflaredInstallState().canInstall) return { started: false, error: 'prereq-missing' };
  if (!cloudflaredPresent()) return { started: false, error: 'not-installed' };
  const tok = (token || '').trim();
  if (!looksLikeTunnelToken(tok)) return { started: false, error: 'bad-token' };
  beginCloudflared();
  const steps: InstallStep[] = [
    {
      run: [
        'bash',
        ['-c', 'cloudflared service uninstall >/dev/null 2>&1 || true; cloudflared service install "$TUNNEL_TOKEN"'],
      ],
      env: { TUNNEL_TOKEN: tok },
    },
  ];
  runInstallChain(cloudflaredInstallState, steps, root);
  return { started: true };
}

// ── LiteLLM install (routing's prerequisite, one-click from Settings) ───────

const litellmInstallState: InstallState = {
  running: false,
  lines: [],
  exitCode: null,
  startedAt: null,
  finishedAt: null,
};

export interface LitellmInstallState extends InstallState {
  /** config.yaml exists — the LiteLLM router is installed. */
  installed: boolean;
  /** The add-litellm skill's installer is present in this checkout. */
  installerPresent: boolean;
}

export function getLitellmInstallState(root = process.cwd()): LitellmInstallState {
  return {
    ...litellmInstallState,
    installed: fs.existsSync(path.join(root, 'data/litellm/config.yaml')),
    installerPresent: fs.existsSync(litellmInstallerPath(root)),
  };
}

export interface StartLitellmResult {
  started: boolean;
  error?: 'already-running' | 'installer-missing';
}

/**
 * One-click LiteLLM router install — routing's prerequisite, run from Settings
 * so the operator never has to drop to a shell for `/add-litellm`. The
 * installer is idempotent and defaults to the local Ollama host; the roster
 * refresh path re-runs it later with the configured hosts. One install at a
 * time; streams into its own state.
 */
export function startLitellmInstall(root = process.cwd(), hosts = 'http://localhost:11434'): StartLitellmResult {
  if (litellmInstallState.running) return { started: false, error: 'already-running' };
  const installer = litellmInstallerPath(root);
  if (!fs.existsSync(installer)) return { started: false, error: 'installer-missing' };
  litellmInstallState.running = true;
  litellmInstallState.lines = [];
  litellmInstallState.exitCode = null;
  litellmInstallState.startedAt = Date.now();
  litellmInstallState.finishedAt = null;
  runInstallChain(litellmInstallState, [{ run: ['bash', [installer, '--hosts', hosts]] }], root);
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

// ── Codex provider install (wizard engine step) ─────────────────────────────
// Installing a *provider* is heavier than Ollama/LiteLLM: it mutates the source
// tree (copy payload from the providers branch, wire the 3 barrels, merge the
// CLI manifest), rebuilds the host + agent image, then needs a HOST restart —
// `codexAvailable()` only flips true once the process re-imports the provider
// barrel at boot. The chain gates the restart on a fully-green build.

const codexInstallState: InstallState = {
  running: false,
  lines: [],
  exitCode: null,
  startedAt: null,
  finishedAt: null,
};

export function getCodexInstallProgress(): InstallState {
  return { ...codexInstallState, lines: codexInstallState.lines.slice(-40) };
}

/**
 * Restart the host so a freshly-installed provider barrel is loaded. Fired only
 * after a green install+build. Detached + a short delay so the HTTP response
 * flushes and the restart survives our own SIGTERM. Context-aware, same trap as
 * the Ollama installer (user vs system systemd vs launchd).
 */
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

function restartHostForProvider(): void {
  const cmd = providerRestartCommand({
    platform: process.platform,
    hasUserSession: Boolean(process.env.XDG_RUNTIME_DIR),
    // The unit we're ACTUALLY running under wins; fall back to the computed name.
    unit: runningSystemdUnit() ?? getSystemdUnit(),
    label: getLaunchdLabel(),
  });
  spawn('sh', ['-c', `sleep 2; ${cmd}`], { detached: true, stdio: 'ignore' }).unref();
}

export function startCodexInstall(root = process.cwd()): {
  started: boolean;
  error?: 'already-running' | 'skill-missing';
} {
  if (codexInstallState.running) return { started: false, error: 'already-running' };
  if (!fs.existsSync(path.join(root, '.claude/skills/add-codex/SKILL.md'))) {
    return { started: false, error: 'skill-missing' };
  }
  codexInstallState.running = true;
  codexInstallState.lines = [];
  codexInstallState.exitCode = null;
  codexInstallState.startedAt = Date.now();
  codexInstallState.finishedAt = null;
  runInstallChain(codexInstallState, codexInstallSteps(root), root);
  return { started: true };
}

/**
 * The Codex install chain. Extracted + exported so the container-typecheck guard
 * is a TESTED invariant, not a fragile inline hunk — #247 added it and a branch
 * rebuild silently dropped it once already.
 *
 * runInstallChain stops on the first non-zero exit, so the restart step is reached
 * ONLY when install + both builds are green — never restart into a broken tree.
 * The agent-runner typecheck needs its Bun deps (bun-types) on the HOST; a deployed
 * tarball install never runs `bun install` here (those deps live only inside the
 * Docker image), so the check would die with "Cannot find type definition file for
 * 'bun'". Run it only where the host has them (a dev checkout); container/build.sh
 * compiles the same code inside the image anyway.
 */
export function codexInstallSteps(root: string): InstallStep[] {
  const canTypecheckContainer = fs.existsSync(path.join(root, 'container/agent-runner/node_modules/bun-types'));
  return [
    { run: ['pnpm', ['exec', 'tsx', 'setup/index.ts', '--step', 'provider-install', 'codex']] },
    { run: ['pnpm', ['run', 'build']] },
    ...(canTypecheckContainer
      ? [{ run: ['pnpm', ['exec', 'tsc', '-p', 'container/agent-runner/tsconfig.json', '--noEmit']] } as InstallStep]
      : []),
    { run: ['bash', ['container/build.sh']] },
    { call: () => restartHostForProvider(), label: 'installed — restarting to load Codex' },
  ];
}

// ── Router (LiteLLM) as a server card ─────────────────────────────────────

export interface RouterInfo {
  available: boolean;
  /** Container-facing endpoint — the canonical form model registrations use. */
  endpoint: string;
  models: string[];
}

/**
 * The LiteLLM roster, presented like an Ollama host: a server with models
 * underneath. Availability = the litellm config exists in this checkout;
 * models come from /v1/models (safeFetch translates host.docker.internal
 * to loopback host-side). The virtual 'auto' model deliberately isn't in
 * the roster — it exists only in the routing hook.
 */
export async function getRouterInfo(root = process.cwd()): Promise<RouterInfo> {
  // LiteLLM's default port from /add-litellm — mirrored in bind-routes.mjs and
  // the app.js roster-endpoint regex; change all three together if it moves.
  const endpoint = 'http://host.docker.internal:4000/v1';
  if (!fs.existsSync(path.join(root, 'data/litellm/config.yaml'))) {
    return { available: false, endpoint, models: [] };
  }
  try {
    const res = await safeFetch(`${endpoint.replace(/\/v1$/, '')}/v1/models`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`router /v1/models returned ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = (body.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string');
    return { available: true, endpoint, models: models.sort() };
  } catch {
    // Config present but router unreachable (container down / mid-refresh):
    // still a server, just empty — the card can say so.
    return { available: true, endpoint, models: [] };
  }
}

// ── Router metrics (dashboard) ─────────────────────────────────────────────

export interface RouterMetrics {
  available: boolean;
  days: number;
  total: number;
  live: number;
  errors: number;
  escalations: number;
  byModel: Array<{ model: string; count: number }>;
  byRoute: Array<{ route: string; count: number }>;
}

/**
 * Aggregate the routing decision log for the dashboard. The shadow hook
 * classifies EVERY completion through LiteLLM, so the JSONL doubles as the
 * per-model request ledger: shadow entries count against the model that was
 * asked for, live ('auto') entries against the model the router chose.
 */
export function computeRouterMetrics(
  text: string,
  days: number,
  nowMs = Date.now(),
): Omit<RouterMetrics, 'available' | 'days'> {
  const since = nowMs - days * 86_400_000;
  const byModel = new Map<string, number>();
  const byRoute = new Map<string, number>();
  let total = 0;
  let live = 0;
  let errors = 0;
  let escalations = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e: {
      ts?: number;
      mode?: string;
      route?: string;
      requested_model?: string;
      final_model?: string;
      bound_model?: string;
    };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof e.ts !== 'number' || e.ts < since) continue;
    total += 1;
    const mode = e.mode || 'shadow';
    if (mode === 'live') live += 1;
    const route = e.route || '?';
    byRoute.set(route, (byRoute.get(route) ?? 0) + 1);
    if (route === '__error__') errors += 1;
    if (e.final_model === '__escalate__' || e.bound_model === '__escalate__') {
      escalations += 1;
      continue; // escalated turns ran on the fallback provider, not a roster model
    }
    const model = mode === 'live' ? e.final_model : e.requested_model;
    if (model) byModel.set(model, (byModel.get(model) ?? 0) + 1);
  }
  const sort = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  return {
    total,
    live,
    errors,
    escalations,
    byModel: sort(byModel).map(([model, count]) => ({ model, count })),
    byRoute: sort(byRoute).map(([route, count]) => ({ route, count })),
  };
}

export function getRouterMetrics(days: number, root = process.cwd()): RouterMetrics {
  const logPath = path.join(root, 'data/litellm/routing/routing-shadow.jsonl');
  if (!fs.existsSync(logPath)) {
    return { available: false, days, total: 0, live: 0, errors: 0, escalations: 0, byModel: [], byRoute: [] };
  }
  return { available: true, days, ...computeRouterMetrics(fs.readFileSync(logPath, 'utf8'), days) };
}

// ── Classifier interface: routes editor, dry classify, decisions tail ─────

interface RouteDef {
  name: string;
  description: string;
  model?: string;
  escalate?: boolean;
  pinned?: boolean;
}

export interface RoutesUpdate {
  routes: RouteDef[];
  live?: { enabled: boolean; model_name?: string; timeout_ms?: number };
  default_route?: string;
}

function routesPathFor(root: string): string {
  return path.join(root, 'data/litellm/routing/routes.json');
}

export function readRoutesConfig(root = process.cwd()): Record<string, unknown> | null {
  const p = routesPathFor(root);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
}

// A routes.json may be single-router (top-level routes) or multi-router
// (a `routers` map). The current single-router GUI operates on the PRIMARY
// router — `auto` if present, else the first defined — so the tab keeps
// working against either shape; full multi-router editing is a later GUI
// phase. KEEP-IN-SYNC with _routers()/routers() in the skill.
export function primaryRouterName(cfg: Record<string, unknown>): string {
  const routers = cfg.routers as Record<string, unknown> | undefined;
  if (routers && typeof routers === 'object') {
    return 'auto' in routers ? 'auto' : (Object.keys(routers)[0] ?? 'auto');
  }
  return (cfg.live as { model_name?: string } | undefined)?.model_name ?? 'auto';
}

export function primaryRouter(cfg: Record<string, unknown>): { routes: RouteDef[]; default_route?: string } {
  const routers = cfg.routers as Record<string, { routes?: RouteDef[]; default_route?: string }> | undefined;
  if (routers && typeof routers === 'object') {
    const r = routers[primaryRouterName(cfg)] ?? {};
    return { routes: r.routes ?? [], default_route: r.default_route };
  }
  return { routes: (cfg.routes as RouteDef[]) ?? [], default_route: cfg.default_route as string | undefined };
}

/**
 * Validate an editor submission and merge it over the on-disk config.
 * The classifier section is never client-writable (endpoint + model are the
 * install's concern); everything else the editor owns. Throws with a
 * human-readable message on invalid input.
 */
export function mergeRoutesUpdate(
  existing: Record<string, unknown>,
  update: RoutesUpdate,
  routerName?: string,
): Record<string, unknown> {
  if (!Array.isArray(update.routes) || update.routes.length === 0) throw new Error('at least one route is required');
  const seen = new Set<string>();
  for (const r of update.routes) {
    if (typeof r.name !== 'string' || !/^[a-z0-9_-]{1,32}$/i.test(r.name)) {
      throw new Error(`route name must be 1-32 word characters: ${JSON.stringify(r.name)}`);
    }
    if (seen.has(r.name)) throw new Error(`duplicate route name: ${r.name}`);
    seen.add(r.name);
    if (typeof r.description !== 'string' || r.description.trim().length < 8) {
      throw new Error(`route "${r.name}" needs a description (it is what the classifier matches against)`);
    }
    if (r.escalate) {
      if (r.model) throw new Error(`escalate route "${r.name}" must not have a model binding`);
    } else if (typeof r.model !== 'string' || !r.model.trim()) {
      throw new Error(`route "${r.name}" needs a model binding`);
    }
  }
  const merged: Record<string, unknown> = { ...existing };
  const newRoutes = update.routes.map((r) => ({
    name: r.name,
    description: r.description.trim(),
    ...(r.escalate ? { escalate: true } : { model: r.model }),
    ...(r.pinned ? { pinned: true } : {}),
  }));
  if (update.default_route !== undefined && !seen.has(update.default_route)) {
    throw new Error(`default_route "${update.default_route}" is not a route`);
  }
  // Multi-router config: edit the PRIMARY router in place; single-router:
  // write the top-level fields as before.
  if (merged.routers && typeof merged.routers === 'object') {
    const map = merged.routers as Record<string, Record<string, unknown>>;
    const name = routerName ?? primaryRouterName(merged);
    if (!(name in map)) throw new Error(`no router named "${name}"`);
    const routers = { ...map };
    routers[name] = { ...(routers[name] ?? {}), routes: newRoutes };
    if (update.default_route !== undefined) routers[name].default_route = update.default_route;
    merged.routers = routers;
  } else {
    merged.routes = newRoutes;
    if (update.default_route !== undefined) merged.default_route = update.default_route;
  }
  if (update.live !== undefined) {
    const prev = (existing.live as Record<string, unknown>) ?? {};
    const timeout = update.live.timeout_ms ?? (prev.timeout_ms as number) ?? 5000;
    if (typeof timeout !== 'number' || timeout < 1000 || timeout > 30000) {
      throw new Error('live.timeout_ms must be between 1000 and 30000');
    }
    merged.live = {
      enabled: Boolean(update.live.enabled),
      model_name: update.live.model_name ?? (prev.model_name as string) ?? 'auto',
      timeout_ms: timeout,
    };
  }
  return merged;
}

export function writeRoutesConfig(cfg: Record<string, unknown>, root = process.cwd()): void {
  const p = routesPathFor(root);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

// ── Router management (Phase 2 picker) ─────────────────────────────────────

/** Ordered router names — `auto` first, then the rest. Normalizes old format. */
export function listRouters(cfg: Record<string, unknown>): string[] {
  const routers = cfg.routers as Record<string, unknown> | undefined;
  const names =
    routers && typeof routers === 'object'
      ? Object.keys(routers)
      : [(cfg.live as { model_name?: string } | undefined)?.model_name ?? 'auto'];
  return names.sort((a, b) => (a === 'auto' ? -1 : b === 'auto' ? 1 : a.localeCompare(b)));
}

/** The named router's routes + default_route (falls back to the primary). */
export function routerView(
  cfg: Record<string, unknown>,
  name?: string,
): { name: string; routes: RouteDef[]; default_route?: string } {
  const routers = cfg.routers as Record<string, { routes?: RouteDef[]; default_route?: string }> | undefined;
  if (routers && typeof routers === 'object') {
    const n = name && name in routers ? name : primaryRouterName(cfg);
    const r = routers[n] ?? {};
    return { name: n, routes: r.routes ?? [], default_route: r.default_route };
  }
  const pr = primaryRouter(cfg);
  return { name: primaryRouterName(cfg), routes: pr.routes, default_route: pr.default_route };
}

/** Convert a config to the multi-router shape in memory (no-op if already). */
function toMultiRouter(cfg: Record<string, unknown>): Record<string, unknown> {
  if (cfg.routers && typeof cfg.routers === 'object') return { ...cfg };
  const name = (cfg.live as { model_name?: string } | undefined)?.model_name ?? 'auto';
  const { routes, default_route, live, classifier } = cfg as Record<string, unknown>;
  return {
    classifier,
    live: { enabled: Boolean((live as { enabled?: boolean } | undefined)?.enabled) },
    routers: {
      [name]: {
        default_route,
        timeout_ms: (live as { timeout_ms?: number } | undefined)?.timeout_ms ?? 5000,
        routes: routes ?? [],
      },
    },
  };
}

/** Add a router, cloning the primary router's routes as the starting point.
 *  Converts a single-router config to multi-router first. Returns the new cfg. */
export function addRouter(cfg: Record<string, unknown>, name: string): Record<string, unknown> {
  if (!/^[a-z0-9_-]{1,32}$/i.test(name))
    throw new Error('router name must be 1-32 letters, digits, dash or underscore');
  const next = toMultiRouter(cfg);
  const routers = next.routers as Record<string, unknown>;
  if (name in routers) throw new Error(`router "${name}" already exists`);
  const seed = routerView(cfg); // clone the primary as a starting point
  next.routers = {
    ...routers,
    [name]: { default_route: seed.default_route, timeout_ms: 8000, routes: JSON.parse(JSON.stringify(seed.routes)) },
  };
  return next;
}

/**
 * Remove ONE route from a named router (model-delete cascade). Refuses the
 * router's default route — the default is the fallback every classification
 * can land on; rebind it before deleting the model it points at.
 */
export function removeRouteFromConfig(cfg: Record<string, unknown>, routerName: string, routeName: string): void {
  const next = toMultiRouter(cfg);
  const routers = next.routers as Record<string, { routes?: RouteDef[]; default_route?: string }>;
  const r = routers[routerName];
  if (!r) throw new Error(`no router named "${routerName}"`);
  if (r.default_route === routeName) {
    throw new Error(`route "${routeName}" is ${routerName}'s default — rebind the default first`);
  }
  r.routes = (r.routes ?? []).filter((x) => x.name !== routeName);
  cfg.routers = routers;
  if ('routes' in cfg) delete (cfg as Record<string, unknown>).routes;
  if ('default_route' in cfg) delete (cfg as Record<string, unknown>).default_route;
}

/** Remove a router. Refuses the last one. Returns the new cfg. */
export function deleteRouter(cfg: Record<string, unknown>, name: string): Record<string, unknown> {
  const next = toMultiRouter(cfg);
  const routers = { ...(next.routers as Record<string, unknown>) };
  if (!(name in routers)) throw new Error(`no router named "${name}"`);
  if (Object.keys(routers).length <= 1) throw new Error('cannot delete the last router');
  delete routers[name];
  next.routers = routers;
  return next;
}

// The classifier prompt contract — KEEP IN SYNC with router_hook.py
// (TASK_INSTRUCTION / FORMAT_PROMPT). The bench must classify exactly the
// way the hook does or its answers are lies.
const CLASSIFY_TASK = `You are a helpful assistant designed to find the best suited route.
You are provided with route description within <routes></routes> XML tags:
<routes>
{routes}
</routes>

<conversation>
{conversation}
</conversation>
`;
const CLASSIFY_FORMAT = `Your task is to decide which route is best suit with user intent on the conversation in <conversation></conversation> XML tags.  Follow the instruction:
1. If the latest intent from user is irrelevant or user intent is full filled, response with other route {"route": "other"}.
2. You must analyze the route descriptions and find the best match route for user latest intent.
3. You only response the name of the route that best matches the user's request, use the exact name in the <routes></routes>.

Based on your analysis, provide your response in the following JSON formats if you decide to match any route:
{"route": "route_name"}`;

export function parseClassifierRoute(raw: string): string {
  const s = raw.trim();
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i < 0 || j <= i) throw new Error(`no JSON object in classifier reply: ${s.slice(0, 80)}`);
  return (JSON.parse(s.slice(i, j + 1).replace(/'/g, '"')) as { route: string }).route;
}

/** Dry classify: run the real classifier on a prompt, change nothing. */
export async function dryClassify(
  prompt: string,
  root = process.cwd(),
): Promise<{ route: string; model: string | null; ms: number }> {
  const cfg = readRoutesConfig(root);
  if (!cfg) throw new Error('routing is not installed');
  const classifier = cfg.classifier as { url: string; model: string; keep_alive?: string };
  const { routes, default_route } = primaryRouter(cfg); // bench classifies against the primary router
  const routeDescs = routes.map((r) => ({ name: r.name, description: r.description }));
  const content =
    CLASSIFY_TASK.replace('{routes}', JSON.stringify(routeDescs)).replace(
      '{conversation}',
      JSON.stringify([{ role: 'user', content: prompt }]),
    ) + CLASSIFY_FORMAT;
  const t0 = Date.now();
  const res = await safeFetch(classifier.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: classifier.model,
      stream: false,
      options: { temperature: 0, num_predict: 64 },
      keep_alive: classifier.keep_alive ?? '60m',
      messages: [{ role: 'user', content }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`classifier returned ${res.status}`);
  const body = (await res.json()) as { message?: { content?: string } };
  const route = parseClassifierRoute(body.message?.content ?? '');
  const ms = Date.now() - t0;
  const hit = routes.find((r) => r.name === route);
  const fallback = routes.find((r) => r.name === default_route);
  const model = hit?.escalate ? '__escalate__' : (hit?.model ?? fallback?.model ?? null);
  return { route, model, ms };
}

/** Last N routing decisions, newest first. */
export function recentDecisions(limit: number, root = process.cwd()): Array<Record<string, unknown>> {
  const p = path.join(root, 'data/litellm/routing/routing-shadow.jsonl');
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
  const out: Array<Record<string, unknown>> = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      out.push(JSON.parse(lines[i]) as Record<string, unknown>);
    } catch {
      /* torn line */
    }
  }
  return out;
}

// ── Route suggestions: propose a route for a capability nothing covers yet ──

interface CapabilityCatalog {
  entries: Array<{ pattern: string; quality: Record<string, number> }>;
  max_comfortable_b: number;
  size_penalty_per_b: number;
}

export interface RouteSuggestion {
  capability: string;
  description: string;
  model: string; // recommended binding (best-scoring roster model for the capability)
  models: string[]; // roster models that have this capability
}

// Default descriptions for the auto-created route. Operator tunes afterward in
// the Rules sub-tab — this is a starting point, not a fixed rule. Unknown
// capabilities fall back to a generic sentence.
const ROUTE_TEMPLATES: Record<string, string> = {
  code: 'Writing, debugging, or explaining code, scripts, or software configuration',
  reasoning: 'Multi-step planning, math, logic, or analysis requiring careful thought',
  general: 'Everyday conversation, quick questions, summaries, casual requests',
  vision:
    'Questions about images, screenshots, photos, diagrams, or visual content — anything requiring looking at a picture',
};

/**
 * Read the skill-owned capability catalog (capabilities.json), merged under the
 * operator's optional capabilities.local.json (same shape, matched first).
 * Returns null when the routing skill isn't installed.
 */
export function readCapabilityCatalog(root = process.cwd()): CapabilityCatalog | null {
  const stockPath = path.join(root, '.claude/skills/add-routing/resources/capabilities.json');
  if (!fs.existsSync(stockPath)) return null;
  const stock = JSON.parse(fs.readFileSync(stockPath, 'utf8')) as CapabilityCatalog;
  const localPath = path.join(root, 'data/litellm/routing/capabilities.local.json');
  const local = fs.existsSync(localPath)
    ? (JSON.parse(fs.readFileSync(localPath, 'utf8')) as Partial<CapabilityCatalog>)
    : null;
  if (!local) return stock;
  return {
    max_comfortable_b: local.max_comfortable_b ?? stock.max_comfortable_b,
    size_penalty_per_b: local.size_penalty_per_b ?? stock.size_penalty_per_b,
    entries: [...(local.entries ?? []), ...stock.entries], // local matched first
  };
}

function catalogEntryFor(modelId: string, cat: CapabilityCatalog) {
  const id = modelId.toLowerCase();
  return cat.entries.find((e) => id.includes(e.pattern.toLowerCase())) ?? null;
}

// Same score as bind-routes.mjs: quality minus a size penalty so an oversized
// specialist loses to a right-sized one on modest hardware. Kept in sync.
function scoreFor(modelId: string, capability: string, cat: CapabilityCatalog): number | null {
  const entry = catalogEntryFor(modelId, cat);
  const quality = entry?.quality?.[capability];
  if (quality == null) return null;
  const m = modelId.toLowerCase().match(/(\d+(?:\.\d+)?)b\b/);
  const paramB = m ? parseFloat(m[1]) : null;
  const penalty =
    paramB != null && paramB > cat.max_comfortable_b ? (paramB - cat.max_comfortable_b) * cat.size_penalty_per_b : 0;
  return quality - penalty;
}

/**
 * Capabilities present in the roster (per the catalog) that NO existing route
 * covers — each with a default description and the best model to bind. Empty
 * when the skill/catalog/router isn't available or every capability is routed.
 */
export async function getRouteSuggestions(root = process.cwd()): Promise<RouteSuggestion[]> {
  const cfg = readRoutesConfig(root);
  const cat = readCapabilityCatalog(root);
  if (!cfg || !cat) return [];
  const info = await getRouterInfo(root);
  if (!info.available || info.models.length === 0) return [];
  return computeRouteSuggestions(primaryRouter(cfg).routes, info.models, cat);
}

/** Pure core (exported for tests): uncovered-capability suggestions from the
 *  routes + roster + catalog. */
export function computeRouteSuggestions(
  routes: Array<{ name: string }>,
  roster: string[],
  cat: CapabilityCatalog,
): RouteSuggestion[] {
  const covered = new Set(routes.map((r) => r.name));
  const byCap = new Map<string, { best: string; bestScore: number; models: string[] }>();
  for (const model of roster) {
    const entry = catalogEntryFor(model, cat);
    if (!entry) continue;
    for (const capability of Object.keys(entry.quality ?? {})) {
      if (covered.has(capability)) continue; // a route already handles it
      const s = scoreFor(model, capability, cat);
      if (s == null) continue;
      const cur = byCap.get(capability);
      if (!cur) byCap.set(capability, { best: model, bestScore: s, models: [model] });
      else {
        cur.models.push(model);
        if (s > cur.bestScore) {
          cur.best = model;
          cur.bestScore = s;
        }
      }
    }
  }
  return [...byCap.entries()].map(([capability, v]) => ({
    capability,
    description: ROUTE_TEMPLATES[capability] ?? `Prompts best suited to ${capability}`,
    model: v.best,
    models: v.models.sort(),
  }));
}
