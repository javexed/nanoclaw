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
export function computeRouterMetrics(text: string, days: number, nowMs = Date.now()): Omit<RouterMetrics, 'available' | 'days'> {
  const since = nowMs - days * 86_400_000;
  const byModel = new Map<string, number>();
  const byRoute = new Map<string, number>();
  let total = 0;
  let live = 0;
  let errors = 0;
  let escalations = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e: { ts?: number; mode?: string; route?: string; requested_model?: string; final_model?: string; bound_model?: string };
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

/**
 * Validate an editor submission and merge it over the on-disk config.
 * The classifier section is never client-writable (endpoint + model are the
 * install's concern); everything else the editor owns. Throws with a
 * human-readable message on invalid input.
 */
export function mergeRoutesUpdate(existing: Record<string, unknown>, update: RoutesUpdate): Record<string, unknown> {
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
  merged.routes = update.routes.map((r) => ({
    name: r.name,
    description: r.description.trim(),
    ...(r.escalate ? { escalate: true } : { model: r.model }),
    ...(r.pinned ? { pinned: true } : {}),
  }));
  if (update.default_route !== undefined) {
    if (!seen.has(update.default_route)) throw new Error(`default_route "${update.default_route}" is not a route`);
    merged.default_route = update.default_route;
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
export async function dryClassify(prompt: string, root = process.cwd()): Promise<{ route: string; model: string | null; ms: number }> {
  const cfg = readRoutesConfig(root);
  if (!cfg) throw new Error('routing is not installed');
  const classifier = cfg.classifier as { url: string; model: string; keep_alive?: string };
  const routes = cfg.routes as RouteDef[];
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
  const fallback = routes.find((r) => r.name === cfg.default_route);
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
  const penalty = paramB != null && paramB > cat.max_comfortable_b ? (paramB - cat.max_comfortable_b) * cat.size_penalty_per_b : 0;
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
  return computeRouteSuggestions(cfg.routes as Array<{ name: string }>, info.models, cat);
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
