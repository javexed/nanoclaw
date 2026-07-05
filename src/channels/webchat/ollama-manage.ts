/**
 * Ollama host management for the webchat Models tab (owner-only surface).
 *
 * Three capabilities, all operating on operator-supplied Ollama endpoints
 * (every outbound fetch goes through models.ts's safeFetch SSRF gate):
 *
 *   1. listHostModels(host)  — installed models (/api/tags) merged with
 *      what's currently loaded and its VRAM split (/api/ps).
 *   2. Pull manager — start a model pull (/api/pull, streamed NDJSON) and
 *      expose progress snapshots the client polls. One active pull per
 *      host+model; finished jobs linger ~10 minutes so a reconnecting
 *      client still sees the outcome.
 *   3. Roster refresh — re-run the /add-litellm installer (and the
 *      /add-routing layer when present) so a freshly pulled model becomes
 *      routable. Shells out to the skill's own installer rather than
 *      duplicating its logic; reports {available:false} when the skill
 *      isn't installed in this checkout, so the UI can hide the button.
 *      (The skills live under .claude/skills/ in installs that ran
 *      /add-litellm — this module only ever references them by path at
 *      runtime, never imports them.)
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { safeFetch } from './models.js';

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

export function getRosterRefreshState(root = process.cwd()): RosterRefreshState {
  refreshState.available = fs.existsSync(litellmInstallerPath(root)) && fs.existsSync(path.join(root, 'data/litellm/config.yaml'));
  return refreshState;
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

  const append = (chunk: Buffer | string): void => {
    for (const l of String(chunk).split('\n')) {
      const line = l.trimEnd();
      if (!line) continue;
      refreshState.lines.push(line);
      if (refreshState.lines.length > LINES_CAP) refreshState.lines.shift();
    }
  };

  const steps: Array<[string, string[]]> = [['bash', [installer, '--hosts', hosts]]];
  if (fs.existsSync(path.join(root, 'data/litellm/router_hook.py')) && fs.existsSync(routingInstallerPath(root))) {
    steps.push(['bash', [routingInstallerPath(root)]]);
  }
  // Capability auto-binding: a refreshed roster re-binds unpinned routes so a
  // freshly pulled model joins routing on its own (see the routing skill's
  // bind-routes.mjs — pins, escalate, and descriptions are never touched).
  if (fs.existsSync(bindRoutesPath(root))) {
    steps.push(['node', [bindRoutesPath(root), '--apply']]);
  }

  const runStep = (i: number): void => {
    if (i >= steps.length) {
      refreshState.running = false;
      refreshState.exitCode = 0;
      refreshState.finishedAt = Date.now();
      return;
    }
    const [cmd, args] = steps[i];
    append(`→ ${args[0].split('/').slice(-1)[0]} …`);
    const child = spawn(cmd, args, { cwd: root });
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('close', (code) => {
      if (code !== 0) {
        refreshState.running = false;
        refreshState.exitCode = code ?? 1;
        refreshState.finishedAt = Date.now();
        return;
      }
      runStep(i + 1);
    });
  };
  runStep(0);
  return true;
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
