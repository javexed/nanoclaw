/**
 * Models — orchestration helpers around the web_models registry.
 *
 * Two non-DB concerns live here:
 *   1. Container plumbing — translate an assigned model into an env-var
 *      override block that the agent's container picks up via Claude
 *      Code's settings.json env. See `writeAgentSettingsForAssignedModel`.
 *      This keeps the integration trunk-free: we don't extend the
 *      agent-runner's container.json schema, we just lean on the
 *      already-mounted settings.json (`.claude-shared/settings.json` is
 *      mounted at `/home/node/.claude` — the SDK's user setting source —
 *      so its `env` block applies to the agent's process).
 *   2. External I/O — Ollama auto-discovery + health checks. Both are
 *      best-effort, fail-soft so a temporarily-unreachable endpoint
 *      doesn't block save/discover entirely.
 */
import fs from 'fs';
import path from 'path';
import dns from 'node:dns/promises';

import { DATA_DIR } from '../../config.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { listProviderContainerConfigNames } from '../../providers/provider-container-registry.js';
import { log } from '../../log.js';
import { readEnvFile } from '../../env.js';
import { upsertEnv } from './env-write.js';
import { getAssignedModelForAgent, getEffectiveModelForAgent, type WebModel } from './db.js';

// ─── SSRF defense for owner-supplied probe/discover/validate URLs ─────────
//
// The probe endpoint, Ollama discovery, and openai-compat reachability
// check all do a raw fetch() against an operator-typed URL. Without a gate,
// an authenticated owner (or — much worse — anyone who races the
// first-authentication-wins owner promotion) can use those endpoints to
// read host-internal services. The most damaging case: cloud metadata
// (`169.254.169.254/latest/meta-data/iam/...`) — a blind probe surface is
// fine for a malicious URL like that (nothing classifies, no body content
// leaks back), but timing alone confirms reachability and a future change
// to surface body content would silently turn this into a read primitive.
//
// What we block by default: link-local (covers all cloud metadata IPs),
// 0.0.0.0/8 (default route), multicast, plus non-http(s) schemes
// (`file://`, `gopher://` would be silly on `fetch` but cheap to refuse).
//
// What we *don't* block by default: loopback, RFC1918, CGNAT (Tailscale).
// These are the legit Ollama-on-LAN destinations — blocking them would
// make the probe useless for the primary use case. Operators who run with
// untrusted owners or in hardened environments can opt into stricter
// blocking via `WEB_BLOCK_PRIVATE_IPS=true`.

const BLOCKED_HOSTNAME_SUFFIXES = ['metadata.google.internal', 'metadata.azure.com', 'metadata.azure.internal'];

interface IpRange {
  cidr: string;
  test: (ip: string) => boolean;
}

const ALWAYS_BLOCKED_RANGES: IpRange[] = [
  // Link-local IPv4 — includes cloud metadata (AWS/GCP at 169.254.169.254,
  // Azure at 169.254.169.254 too, Alibaba at 100.100.100.200 — that one's
  // CGNAT not link-local, the env opt-in covers it).
  { cidr: '169.254.0.0/16', test: (ip) => ip.startsWith('169.254.') },
  // 0.0.0.0/8 — "this network", invalid as a fetch target but some hosts
  // resolve "this host" to 0.0.0.0 which fetches the bound-to-all listener.
  { cidr: '0.0.0.0/8', test: (ip) => ip.startsWith('0.') },
  // Multicast — never a legit unicast HTTP destination.
  {
    cidr: '224.0.0.0/4',
    test: (ip) => {
      const first = parseInt(ip.split('.')[0], 10);
      return first >= 224 && first <= 239;
    },
  },
  // Link-local IPv6 (fe80::/10) and unspecified.
  {
    cidr: 'fe80::/10',
    test: (ip) =>
      ip.toLowerCase().startsWith('fe80:') ||
      ip.toLowerCase().startsWith('fe9') ||
      ip.toLowerCase().startsWith('fea') ||
      ip.toLowerCase().startsWith('feb'),
  },
  { cidr: '::', test: (ip) => ip === '::' || ip === '::0' },
];

const PRIVATE_RANGES: IpRange[] = [
  // Loopback IPv4
  { cidr: '127.0.0.0/8', test: (ip) => ip.startsWith('127.') },
  // RFC 1918
  { cidr: '10.0.0.0/8', test: (ip) => ip.startsWith('10.') },
  {
    cidr: '172.16.0.0/12',
    test: (ip) => {
      if (!ip.startsWith('172.')) return false;
      const n = parseInt(ip.split('.')[1], 10);
      return n >= 16 && n <= 31;
    },
  },
  { cidr: '192.168.0.0/16', test: (ip) => ip.startsWith('192.168.') },
  // CGNAT (Tailscale uses 100.64.0.0/10)
  {
    cidr: '100.64.0.0/10',
    test: (ip) => {
      if (!ip.startsWith('100.')) return false;
      const n = parseInt(ip.split('.')[1], 10);
      return n >= 64 && n <= 127;
    },
  },
  // Loopback / unique-local / site-local IPv6
  { cidr: '::1', test: (ip) => ip === '::1' },
  { cidr: 'fc00::/7', test: (ip) => /^f[cd]/.test(ip.toLowerCase()) },
];

function isBlockedIp(rawIp: string): { blocked: boolean; reason?: string } {
  // Collapse IPv4-mapped IPv6 (::ffff:169.254.169.254, and the deprecated
  // ::ffff:a9fe:a9fe hex form) to the bare IPv4 so the v4 range checks apply —
  // otherwise a mapped metadata address slips every string-prefix test and,
  // on a dual-stack host, fetch() reaches it.
  const m = /^::ffff:(.+)$/i.exec(rawIp);
  let ip = rawIp;
  if (m) {
    const tail = m[1];
    if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) {
      ip = tail;
    } else {
      const hex = tail.replace(':', '');
      if (/^[0-9a-f]{8}$/i.test(hex)) {
        const n = parseInt(hex, 16);
        ip = `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
      }
    }
  }
  for (const r of ALWAYS_BLOCKED_RANGES) {
    if (r.test(ip)) return { blocked: true, reason: `IP ${ip} is in always-blocked range ${r.cidr}` };
  }
  if (process.env.WEB_BLOCK_PRIVATE_IPS === 'true') {
    for (const r of PRIVATE_RANGES) {
      if (r.test(ip))
        return { blocked: true, reason: `IP ${ip} is in private range ${r.cidr} (WEB_BLOCK_PRIVATE_IPS=true)` };
    }
  }
  return { blocked: false };
}

/**
 * Validate that a URL is safe to fetch from the host process. Throws on:
 *   - invalid URL or non-http(s) scheme
 *   - hostname matching a known cloud-metadata FQDN
 *   - hostname resolving to an always-blocked IP range
 *   - (with WEB_BLOCK_PRIVATE_IPS=true) hostname resolving to a
 *     private/loopback/CGNAT range
 *
 * Resolves via OS DNS (the same resolver fetch() uses), then iterates all
 * resolved addresses — DNS rebinding defense is best-effort here since
 * fetch() may resolve again, but a TTL=0 race is a known limit of any
 * in-process SSRF gate.
 */
export async function assertSafeOutboundUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (err) {
    throw new Error(`Invalid URL: ${rawUrl}`, { cause: err });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http/https URLs allowed; got ${url.protocol}`);
  }
  const host = url.hostname.toLowerCase();
  for (const suf of BLOCKED_HOSTNAME_SUFFIXES) {
    if (host === suf || host.endsWith('.' + suf)) {
      throw new Error(`Blocked hostname: ${host}`);
    }
  }
  // dns.lookup uses the OS resolver — same one fetch() consults.
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch (err) {
    // Fail CLOSED: an attacker who controls the authoritative DNS can SERVFAIL
    // the gate's lookup and then answer fetch()'s own resolution with a blocked
    // IP — a scriptable bypass. Refuse rather than let fetch resolve unchecked.
    throw new Error(`Could not resolve ${host} for the safety check`, { cause: err });
  }
  for (const a of addrs) {
    const check = isBlockedIp(a.address);
    if (check.blocked) throw new Error(check.reason ?? `IP ${a.address} blocked`);
  }
}

/**
 * URL translation between the two perspectives an endpoint is used from.
 *
 * Operators register endpoints as reachable FROM THE HOST (that's where the
 * probe and save-validation run); agent containers consume them FROM INSIDE
 * DOCKER. `localhost`/`127.0.0.1` means a different machine in each place,
 * and `host.docker.internal` only resolves inside containers (via the
 * --add-host host-gateway alias every agent container gets).
 */

/** Container-facing form: loopback → host.docker.internal. For env writes. */
export function containerReachableUrl(url: string): string {
  return url.replace(/^(https?:\/\/)(localhost|127\.0\.0\.1)(?=[:/]|$)/, '$1host.docker.internal');
}

/** Host-facing form: host.docker.internal → 127.0.0.1. For host-side fetches. */
export function hostReachableUrl(url: string): string {
  return url.replace(/^(https?:\/\/)host\.docker\.internal(?=[:/]|$)/, '$1127.0.0.1');
}

/**
 * Drop-in fetch wrapper that runs assertSafeOutboundUrl first. Throws the
 * same errors fetch would for unreachable hosts plus our SSRF rejections.
 * Use this for ANY fetch where the URL came from operator input.
 *
 * Fetches run on the host, so the container-only alias is translated to
 * loopback first — an operator can paste either form and both probe and
 * save-validation just work.
 */
export async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  const MAX_HOPS = 5;
  let target = hostReachableUrl(url);
  let reqInit: RequestInit = { ...init };
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    // Re-run the SSRF gate on EVERY hop. `redirect: 'manual'` stops fetch from
    // silently following a 3xx to 169.254.169.254 / a private host without a
    // check — the whole point of the gate. (Node/undici exposes the redirect
    // status + Location header under 'manual'.)
    await assertSafeOutboundUrl(target);
    const res = await fetch(target, { ...reqInit, redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) return res; // not a redirect → done
    const location = res.headers.get('location');
    if (!location) throw new Error(`safeFetch: refusing an un-inspectable redirect from ${target}`);
    target = new URL(location, target).toString();
    // 307/308 preserve method + body; 301/302/303 downgrade to a bodyless GET
    // (standard redirect semantics) so a POST body isn't replayed to a new host.
    if (res.status !== 307 && res.status !== 308) reqInit = { ...reqInit, method: 'GET', body: undefined };
  }
  throw new Error(`safeFetch: too many redirects starting at ${url}`);
}

// Curated list of currently-supported Anthropic model ids — a SUGGESTION
// source for the pickers, never a gate. `validateModel` deliberately does not
// reject ids outside this list, and the agent "Anthropic model" field is a
// free-text input with this as its datalist: a NanoClaw install routinely
// outlives the list, and refusing a model Anthropic has already shipped is a
// worse failure than accepting a typo (which surfaces immediately as the
// "couldn't reach the configured model" reply on the agent's next turn).
//
// Update when Anthropic ships new models.
export const KNOWN_ANTHROPIC_MODELS = [
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-7[1m]',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
] as const;

/**
 * Shape gate for an operator-supplied Anthropic model id, used by the agent
 * "Anthropic model" field. Deliberately permissive about WHICH model (see
 * KNOWN_ANTHROPIC_MODELS) and strict only about the characters, so a stray
 * shell fragment or a pasted URL can't land in container_configs.model — the
 * value is handed to the Claude Agent SDK as its `model` option.
 */
export function isPlausibleAnthropicModelId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,72}(\[[a-z0-9]{1,8}\])?$/.test(id);
}

/**
 * Materialize a model choice into the agent group: an Anthropic model sets
 * ANTHROPIC_MODEL in the mounted settings.json; a local model sets nothing
 * there — it runs on OpenCode, wired by syncAgentProviderForAssignedModel
 * (container config) and syncOpenCodeBackendEnv (install env).
 */
/**
 * The env a roster model injects into an agent container's settings.json —
 * ANTHROPIC_MODEL for an Anthropic model. A local model injects nothing here:
 * it runs on OpenCode, configured through the install env
 * (syncOpenCodeBackendEnv) and container_configs, not through the Claude
 * settings file. `{}` clears any override a previous assignment wrote.
 */
export function envForModel(model: WebModel | null): Record<string, string> {
  if (!model || model.kind !== 'anthropic') return {};
  return { ANTHROPIC_MODEL: model.model_id };
}

/**
 * Write the model's env overrides into the agent's per-group settings.json.
 *
 * Path: data/v2-sessions/<agent_group_id>/.claude-shared/settings.json
 * Mount: that dir is mounted at /home/node/.claude inside the container, so
 *        Claude Code reads it as the user settings source. The SDK applies
 *        the `env` block to the process at startup.
 *
 * Effect timing: takes effect on the NEXT container spawn for this agent.
 * Existing containers keep using the env they were started with. (The
 * sweep recycles idle containers on a short timer, and any wake after this
 * write picks up the new env.)
 *
 * Idempotent. Preserves any pre-existing env keys we don't manage.
 */
export async function writeAgentSettingsForAssignedModel(agentGroupId: string): Promise<void> {
  // Per-agent assignment wins; a claude-family group WITHOUT one falls back to
  // the workspace default model (wizard "default engine = Ollama"). Groups on
  // a non-default provider (e.g. codex) never inherit the fallback — their
  // harness doesn't read the ANTHROPIC_* env this writes.
  let model = await getAssignedModelForAgent(agentGroupId);
  if (!model) {
    const provider = (await getContainerConfig(agentGroupId))?.provider;
    if (!provider || provider === 'claude') model = await getEffectiveModelForAgent(agentGroupId);
  }
  const overrides = envForModel(model);

  const settingsPath = path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.claude-shared', 'settings.json');
  if (!fs.existsSync(path.dirname(settingsPath))) {
    // Folder hasn't been initialized yet — nothing to write. The first
    // resolveSession will create it; we'll re-run this then.
    return;
  }

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      // corrupt — start fresh, log so the operator notices
      log.warn('Web: settings.json unparseable, rewriting from scratch', { agentGroupId });
    }
  }
  const existingEnv = (
    typeof existing.env === 'object' && existing.env !== null ? (existing.env as Record<string, string>) : {}
  ) as Record<string, string>;

  // Strip any keys we manage from the existing env so removing the
  // assignment fully clears them. Cover both Anthropic-shaped and
  // OpenAI-shaped overrides — switching kinds (e.g. ollama → openai-
  // compatible) shouldn't leave the previous shape's env vars behind.
  const cleaned = { ...existingEnv };
  delete cleaned.ANTHROPIC_BASE_URL;
  delete cleaned.ANTHROPIC_MODEL;
  delete cleaned.OPENAI_BASE_URL;
  delete cleaned.OPENAI_MODEL;
  delete cleaned.NO_PROXY;
  delete cleaned.no_proxy;

  const merged = { ...existing, env: { ...cleaned, ...overrides } };
  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n');
}

// ── Local models run on OpenCode ────────────────────────────────────────────
//
// Anything in the roster that is not an Anthropic model is a local
// OpenAI-compatible backend — Ollama, LM Studio, vLLM, a LiteLLM router — and
// those run on upstream's OpenCode harness (/add-opencode), never on the Claude
// provider. This follows upstream's own contract exactly:
//
//   which harness      container_configs.provider = 'opencode'
//   which model        container_configs.model = 'openai/<id>' (the runner strips the prefix)
//   which backend      install-wide .env: OPENCODE_PROVIDER=openai, OPENCODE_BASE_URL=<endpoint>/v1,
//                      OPENCODE_MODEL_CONTEXT_LIMIT + OPENCODE_MODEL_OUTPUT_LIMIT — both required,
//                      or OpenCode's session creation fails on "Missing key"
//   reaching the host  NO_PROXY carries the docker host alias so the call bypasses the OneCLI
//                      credential proxy, which fronts known providers and resets the rest
//
// One backend per install is the shape upstream offers; the model is per agent.

/** OpenCode is installed iff its provider container-config is registered. */
function opencodeInstalled(): boolean {
  return listProviderContainerConfigNames().includes('opencode');
}

/**
 * Which harness a model kind runs on. Local kinds need OpenCode; until it is
 * installed there is no harness for them and the agent stays on the default.
 */
export function providerForModelKind(kind: string | null | undefined): 'opencode' | null {
  if (!kind || kind === 'anthropic') return null;
  return opencodeInstalled() ? 'opencode' : null;
}

export const OPENCODE_DEFAULT_CONTEXT_LIMIT = 32768;
export const OPENCODE_DEFAULT_OUTPUT_LIMIT = 8192;

/**
 * The install-wide keys a local roster model maps onto. Pure; null for an
 * Anthropic model or one without an endpoint. The provider id is `openai` —
 * the OpenAI-compatible transport is pinned to that id — not `ollama`.
 */
export function openCodeBackendEnv(model: WebModel): { env: Record<string, string>; proxyHost: string } | null {
  if (model.kind === 'anthropic' || !model.endpoint) return null;
  // OpenCode speaks OpenAI-compat at /v1/chat/completions, so the base URL
  // takes the /v1 suffix; registry endpoints may already carry it.
  const base = containerReachableUrl(model.endpoint.replace(/\/+$/, '').replace(/\/v1$/, '')) + '/v1';
  let proxyHost = 'host.docker.internal';
  try {
    proxyHost = new URL(base).hostname;
  } catch {
    /* keep the alias */
  }
  return {
    env: { OPENCODE_PROVIDER: 'openai', OPENCODE_BASE_URL: base, OPENCODE_MODEL: `openai/${model.model_id}` },
    proxyHost,
  };
}

function mergeNoProxy(current: string | undefined, host: string): string {
  const parts = new Set(
    (current ?? '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  parts.add(host);
  return [...parts].join(',');
}

/**
 * Point the install's OpenCode at this model's backend. Provider, base URL and
 * model are set outright; the two limits only if absent, so an operator's
 * values stick. NO_PROXY is merged into .env AND into this process's env:
 * upstream's host provider reads the host process env (ctx.hostEnv) and does
 * not yet fall back to .env for NO_PROXY, so the process copy is what reaches
 * the container today, and the file copy is what will once it does.
 */
export function syncOpenCodeBackendEnv(model: WebModel): boolean {
  const backend = openCodeBackendEnv(model);
  if (!backend) return false;
  const root = process.cwd();
  for (const [k, v] of Object.entries(backend.env)) upsertEnv(root, k, v);
  const have = readEnvFile(['OPENCODE_MODEL_CONTEXT_LIMIT', 'OPENCODE_MODEL_OUTPUT_LIMIT', 'NO_PROXY'], root);
  if (!have.OPENCODE_MODEL_CONTEXT_LIMIT) {
    upsertEnv(root, 'OPENCODE_MODEL_CONTEXT_LIMIT', String(OPENCODE_DEFAULT_CONTEXT_LIMIT));
  }
  if (!have.OPENCODE_MODEL_OUTPUT_LIMIT) {
    upsertEnv(root, 'OPENCODE_MODEL_OUTPUT_LIMIT', String(OPENCODE_DEFAULT_OUTPUT_LIMIT));
  }
  upsertEnv(root, 'NO_PROXY', mergeNoProxy(have.NO_PROXY, backend.proxyHost));
  process.env.NO_PROXY = mergeNoProxy(process.env.NO_PROXY, backend.proxyHost);
  process.env.no_proxy = process.env.NO_PROXY;
  log.info('Web: OpenCode backend set', { base: backend.env.OPENCODE_BASE_URL, model: backend.env.OPENCODE_MODEL });
  return true;
}

/**
 * Keep the agent group's harness in lockstep with its EFFECTIVE model (the
 * per-agent assignment, else the workspace default): a local model → OpenCode
 * when installed, with the backend env written; an Anthropic model → the
 * default provider. Only the Claude ↔ OpenCode axis is managed — any other
 * explicit harness (codex, …) is never clobbered. An OpenCode choice the
 * operator made by hand (e.g. for a cloud OpenCode backend) stays put when the
 * roster model is Anthropic; only a model id this module wrote is cleared.
 * Idempotent; takes effect on the next spawn, like the settings.json write.
 */
export async function syncAgentProviderForAssignedModel(agentGroupId: string): Promise<void> {
  const row = await getContainerConfig(agentGroupId);
  const current = row?.provider ?? null;
  if (current && current !== 'claude' && current !== 'opencode') return;
  const model = await getEffectiveModelForAgent(agentGroupId);
  await ensureContainerConfig(agentGroupId);
  if (providerForModelKind(model?.kind) === 'opencode' && model) {
    syncOpenCodeBackendEnv(model);
    await updateContainerConfigScalars(agentGroupId, { provider: 'opencode', model: `openai/${model.model_id}` });
    return;
  }
  const updates: Parameters<typeof updateContainerConfigScalars>[1] = {};
  if (row?.model?.startsWith('openai/')) updates.model = null; // ours — never an operator's ncl-set model
  if (!(current === 'opencode' && opencodeInstalled())) updates.provider = null;
  if (Object.keys(updates).length > 0) await updateContainerConfigScalars(agentGroupId, updates);
}

/**
 * Discover models served by an Ollama endpoint via its /api/tags endpoint.
 * Returns the array of model names; throws on failure (invalid URL,
 * unreachable, malformed response).
 */
export async function discoverOllamaModels(endpoint: string): Promise<string[]> {
  const base = endpoint.replace(/\/+$/, '');
  const url = `${base}/api/tags`;
  const res = await safeFetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Ollama /api/tags returned ${res.status}`);
  const body = (await res.json()) as { models?: Array<{ name?: string }> };
  if (!body || !Array.isArray(body.models)) throw new Error('Ollama /api/tags response missing models[]');
  return body.models.map((m) => m.name).filter((n): n is string => typeof n === 'string');
}

/**
 * Two-pass endpoint probe: detect what's serving (Ollama vs OpenAI-compatible —
 * LiteLLM, vLLM, llama.cpp server all speak /v1/models), then list its models.
 */
/**
 * Meet loose input halfway: 'localhost' → ['http://localhost:11434',
 * 'http://localhost'] — scheme added when missing, and when no port was given
 * the Ollama default is tried first. Explicit scheme+port is used as-is.
 */
export function endpointCandidates(raw: string): string[] {
  let v = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(v)) v = `http://${v}`;
  try {
    const u = new URL(v);
    if (!u.port && u.protocol === 'http:') {
      return [`http://${u.hostname}:11434${u.pathname === '/' ? '' : u.pathname}`, v];
    }
  } catch {
    /* fall through — the probe will surface the parse error */
  }
  return [v];
}

export async function probeEndpointKind(
  endpoint: string,
): Promise<{ kind: 'ollama' | 'openai-compatible'; models: string[]; endpoint: string }> {
  const errors: string[] = [];
  for (const base of endpointCandidates(endpoint)) {
    try {
      return { kind: 'ollama', models: await discoverOllamaModels(base), endpoint: base };
    } catch (err) {
      errors.push(`Ollama probe (${base}): ${(err as Error).message}`);
    }
    try {
      const res = await safeFetch(`${base}/v1/models`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`/v1/models returned ${res.status}`);
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      if (!body || !Array.isArray(body.data)) throw new Error('/v1/models response missing data[]');
      return {
        kind: 'openai-compatible',
        models: body.data.map((m) => m.id).filter((n): n is string => typeof n === 'string'),
        endpoint: base,
      };
    } catch (err) {
      errors.push(`OpenAI-compatible probe (${base}): ${(err as Error).message}`);
    }
  }
  throw new Error(`Nothing answered at ${endpoint.trim()} — ${errors.join('; ')}`);
}

/**
 * Check that an Ollama endpoint is reachable and serves the named model.
 * Returns null on success, or an error message string on failure.
 */
export async function healthCheckOllamaModel(endpoint: string, modelId: string): Promise<string | null> {
  try {
    const models = await discoverOllamaModels(endpoint);
    if (!models.includes(modelId)) {
      // Allow tag-less variants — `llama3.1:70b` typed as `llama3.1` etc.
      const stripTag = (s: string): string => s.split(':')[0];
      const bareTarget = stripTag(modelId);
      const found = models.some((m) => stripTag(m) === bareTarget);
      if (!found) {
        return `Model "${modelId}" not installed on this Ollama endpoint. Available: ${models.slice(0, 5).join(', ') || '(none)'}`;
      }
    }
    return null;
  } catch (err) {
    // Not literally Ollama — but the `ollama` kind really means "endpoint that
    // speaks the Anthropic /v1/messages API" (that's all envForModel wires up).
    // A LiteLLM router serving anthropic-spec is exactly as usable, and it has
    // no /api/tags. Probe /v1/messages with a real one-token request — a 200
    // both proves the route AND that the model id resolves. (An intentionally
    // malformed body is no good: LiteLLM 500s on it rather than 400.) 401/403
    // pass too: the endpoint is alive, just auth-gated.
    try {
      const url = `${endpoint.replace(/\/+$/, '')}/v1/messages`;
      const res = await safeFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok || res.status === 401 || res.status === 403) return null;
      const detail = await res.text().catch(() => '');
      return `Anthropic-compatible endpoint returned ${res.status}${detail ? `: ${detail.slice(0, 120)}` : ''}`;
    } catch {
      return `Ollama unreachable: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

/**
 * Validate a model record before persistence. Returns null on OK or an
 * error message string. Run by the POST /api/models handler before insert
 * (and by PUT before update).
 */
export async function validateModel(input: {
  kind: string;
  endpoint?: string | null;
  model_id: string;
}): Promise<string | null> {
  if (input.kind === 'anthropic') {
    if (!input.model_id) return 'model_id required';
    if (!KNOWN_ANTHROPIC_MODELS.includes(input.model_id as (typeof KNOWN_ANTHROPIC_MODELS)[number])) {
      // Soft warning — we allow custom ids in case the user knows about a
      // newer model than the curated list. Just don't fail on it.
      // (No-op return null.)
    }
    return null;
  }
  if (input.kind === 'ollama') {
    if (!input.endpoint) return 'endpoint required for kind=ollama';
    if (!input.model_id) return 'model_id required for kind=ollama';
    return await healthCheckOllamaModel(input.endpoint, input.model_id);
  }
  if (input.kind === 'openai-compatible') {
    if (!input.endpoint) return 'endpoint required for kind=openai-compatible';
    if (!input.model_id) return 'model_id required for kind=openai-compatible';
    // Reachability check only — many OpenAI-compatible endpoints gate
    // /v1/models behind auth, so a 401 isn't a save-blocker.
    try {
      const url = `${input.endpoint.replace(/\/+$/, '')}/v1/models`;
      const res = await safeFetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.status >= 500) return `OpenAI-compatible endpoint returned ${res.status}`;
      // 200, 401, 403 — endpoint is alive; assume model_id is valid.
      return null;
    } catch (err) {
      return `Endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return `Unknown kind: ${input.kind}`;
}
