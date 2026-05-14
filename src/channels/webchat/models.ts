/**
 * Models — orchestration helpers around the webchat_models registry.
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
import { log } from '../../log.js';
import { getAssignedModelForAgent, type WebchatModel } from './db.js';

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
// blocking via `WEBCHAT_BLOCK_PRIVATE_IPS=true`.

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

function isBlockedIp(ip: string): { blocked: boolean; reason?: string } {
  for (const r of ALWAYS_BLOCKED_RANGES) {
    if (r.test(ip)) return { blocked: true, reason: `IP ${ip} is in always-blocked range ${r.cidr}` };
  }
  if (process.env.WEBCHAT_BLOCK_PRIVATE_IPS === 'true') {
    for (const r of PRIVATE_RANGES) {
      if (r.test(ip))
        return { blocked: true, reason: `IP ${ip} is in private range ${r.cidr} (WEBCHAT_BLOCK_PRIVATE_IPS=true)` };
    }
  }
  return { blocked: false };
}

/**
 * Validate that a URL is safe to fetch from the host process. Throws on:
 *   - invalid URL or non-http(s) scheme
 *   - hostname matching a known cloud-metadata FQDN
 *   - hostname resolving to an always-blocked IP range
 *   - (with WEBCHAT_BLOCK_PRIVATE_IPS=true) hostname resolving to a
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
  } catch (_err) {
    // Let the caller's fetch handle DNS failure with its own error message.
    // Don't block on resolution failure — that's not a security issue.
    return;
  }
  for (const a of addrs) {
    const check = isBlockedIp(a.address);
    if (check.blocked) throw new Error(check.reason ?? `IP ${a.address} blocked`);
  }
}

/**
 * Drop-in fetch wrapper that runs assertSafeOutboundUrl first. Throws the
 * same errors fetch would for unreachable hosts plus our SSRF rejections.
 * Use this for ANY fetch where the URL came from operator input.
 */
export async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  await assertSafeOutboundUrl(url);
  return fetch(url, init);
}

// Curated list of currently-supported Anthropic model ids — used both as a
// dropdown source and as cheap validation on save (the host can't make a
// real test call to Anthropic without going through OneCLI, which would
// add latency + cost; an allowlist of known names is the lighter path).
//
// Update when Anthropic ships new models. Out of date is fine — operators
// can also type a model id directly if their version of NanoClaw allows.
export const KNOWN_ANTHROPIC_MODELS = [
  'claude-opus-4-7',
  'claude-opus-4-7[1m]',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
] as const;

/**
 * Compute the env-var overrides for a given model. Returns an empty object
 * when nothing needs to change (caller can use that to wipe the env block).
 *
 * Anthropic-with-custom-model-name: just ANTHROPIC_MODEL.
 * Ollama: ANTHROPIC_BASE_URL pointed at the Ollama endpoint + ANTHROPIC_MODEL.
 *   Ollama serves the Anthropic API at <endpoint>/v1/messages; the SDK
 *   reads ANTHROPIC_BASE_URL and uses it as the API root.
 */
export function envForModel(model: WebchatModel | null): Record<string, string> {
  if (!model) return {};
  if (model.kind === 'anthropic') {
    return { ANTHROPIC_MODEL: model.model_id };
  }
  if (model.kind === 'ollama') {
    if (!model.endpoint) return {};
    // Ollama exposes the Anthropic-compatible API at /v1 — the SDK joins
    // /messages onto whatever ANTHROPIC_BASE_URL is, so we point it at the
    // root /v1 and let it land at /v1/messages.
    const base = model.endpoint.replace(/\/+$/, '');
    return {
      ANTHROPIC_BASE_URL: `${base}/v1`,
      ANTHROPIC_MODEL: model.model_id,
    };
  }
  if (model.kind === 'openai-compatible') {
    // Stored env stub for the OpenCode provider to pick up when the
    // operator installs `/add-opencode` and switches the agent's
    // `agent_provider` to 'opencode'. With the default Claude SDK these
    // env vars are no-ops — the assignment is registered for later use.
    if (!model.endpoint) return {};
    const base = model.endpoint.replace(/\/+$/, '');
    return {
      OPENAI_BASE_URL: base,
      OPENAI_MODEL: model.model_id,
    };
  }
  return {};
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
export function writeAgentSettingsForAssignedModel(agentGroupId: string): void {
  const model = getAssignedModelForAgent(agentGroupId);
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
      log.warn('Webchat: settings.json unparseable, rewriting from scratch', { agentGroupId });
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

  const merged = { ...existing, env: { ...cleaned, ...overrides } };
  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n');
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
    return `Ollama unreachable: ${err instanceof Error ? err.message : String(err)}`;
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

/**
 * Single-URL probe — paste a base URL, get back the kind + the list of
 * models the endpoint exposes. Used by the PWA's "Add by URL" flow.
 *
 * Probe order matters: Ollama also serves `/v1/models` and `/v1/messages`,
 * so we check `/api/tags` first for the most-specific identification.
 *
 * Order:
 *   1. GET <base>/api/tags        → Ollama (definitive)
 *   2. GET <base>/v1/models       → OpenAI-compatible (LM Studio, vLLM, OpenRouter, …)
 *   3. POST <base>/v1/messages    → Anthropic-compatible (returns 401 missing-x-api-key)
 *
 * Each check has a short timeout so an unreachable URL fails fast. Probes
 * run sequentially on purpose — concurrent requests against an arbitrary
 * URL could surprise the operator more than they help; the latency
 * difference is sub-second per check.
 *
 * Returns:
 *   - kind: which provider matched
 *   - models: list of model id strings (best-effort — may be empty for
 *     gated OpenAI-compat endpoints; user can type the id manually)
 *   - requires_credential: true if /v1/models returned 401/403, hint to
 *     the operator that they need to wire OneCLI for this endpoint
 *   - notes: arbitrary advisory string ("requires /add-opencode" etc.)
 *   - kind=null + reason: nothing matched, with the reason for each probe
 */
export interface ProbeResult {
  kind: 'ollama' | 'openai-compatible' | 'anthropic' | null;
  endpoint: string;
  models: string[];
  requires_credential: boolean;
  notes?: string;
  reason?: string;
}

/**
 * Probe a base URL. If the user provides a bare host (no scheme), try
 * both `https://` and `http://` in parallel and return the first that
 * classifies a kind. Most local Ollama installs are http-on-localhost,
 * most public APIs are https — auto-detection saves the user from
 * remembering which.
 *
 * Worst-case latency for a bare unreachable URL: one probeOneScheme
 * window (~12s) — both schemes time out in parallel, not serially.
 */
export async function probeEndpoint(rawUrl: string): Promise<ProbeResult> {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  const candidates = expandUrlCandidates(trimmed);
  if (candidates.length === 1) {
    return probeOneScheme(candidates[0]);
  }
  // Race all candidates in parallel — first one that classifies a kind
  // wins. Total worst-case latency = single probeOneScheme window
  // (~12s) regardless of how many candidates we try.
  const results = await Promise.all(
    candidates.map((url) => probeOneScheme(url).catch((err) => fallbackResult(url, err))),
  );
  for (const r of results) {
    if (r.kind) return r;
  }
  return {
    kind: null,
    endpoint: trimmed,
    models: [],
    requires_credential: false,
    reason: `No known provider responded. Tried: ${candidates.join(', ')}.`,
  };
}

/**
 * Expand a user-supplied URL/host into the set of candidates worth probing.
 *
 * Rules:
 *   - Explicit scheme + port      → just that. (1 candidate)
 *   - Explicit `http://` no port  → port-default + Ollama 11434.
 *   - Explicit `https://` no port → just port-default. (TLS on 11434 not
 *                                    a thing in a default Ollama install.)
 *   - Bare host + port            → http and https on the given port.
 *   - Bare host, no port          → http and https on default ports +
 *                                    http on 11434. (3 candidates)
 */
function expandUrlCandidates(input: string): string[] {
  const schemeMatch = input.match(/^(https?):\/\/(.+)$/i);
  let scheme: 'http' | 'https' | null = null;
  let rest: string;
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase() as 'http' | 'https';
    rest = schemeMatch[2];
  } else {
    rest = input;
  }
  // Split host[:port] from any trailing path so we can detect explicit ports.
  const slashIdx = rest.indexOf('/');
  const hostPort = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
  const path = slashIdx >= 0 ? rest.slice(slashIdx) : '';
  const hasPort = /:\d+$/.test(hostPort);

  const out = new Set<string>();
  if (scheme) {
    out.add(`${scheme}://${hostPort}${path}`);
    if (!hasPort && scheme === 'http') {
      // Same scheme as user requested — try Ollama port too.
      out.add(`http://${hostPort}:11434${path}`);
    }
  } else {
    out.add(`http://${hostPort}${path}`);
    out.add(`https://${hostPort}${path}`);
    if (!hasPort) {
      out.add(`http://${hostPort}:11434${path}`);
    }
  }
  return [...out];
}

function fallbackResult(endpoint: string, err: unknown): ProbeResult {
  return {
    kind: null,
    endpoint,
    models: [],
    requires_credential: false,
    reason: `Probe error on ${endpoint}: ${err instanceof Error ? err.message : String(err)}`,
  };
}

async function probeOneScheme(rawUrl: string): Promise<ProbeResult> {
  const base = rawUrl.replace(/\/+$/, '');
  const result: ProbeResult = {
    kind: null,
    endpoint: base,
    models: [],
    requires_credential: false,
  };

  // 1. Ollama — /api/tags
  try {
    const r = await safeFetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const body = (await r.json()) as { models?: Array<{ name?: string }> };
      if (Array.isArray(body?.models)) {
        result.kind = 'ollama';
        result.models = body.models.map((m) => m.name).filter((n): n is string => typeof n === 'string');
        return result;
      }
    }
  } catch {
    // fall through to next probe
  }

  // 2. OpenAI-compatible OR Anthropic — both expose /v1/models. Real
  //    Anthropic returns 401 with `x-api-key header is required` in the
  //    body; OpenAI-compat returns generic auth error. Check the body to
  //    disambiguate the 401/403 case.
  try {
    const r = await safeFetch(`${base}/v1/models`, { signal: AbortSignal.timeout(4000) });
    if (r.status === 401 || r.status === 403) {
      const body = await r.text();
      const lo = body.toLowerCase();
      if (lo.includes('x-api-key') || lo.includes('"type":"authentication_error"') || lo.includes('anthropic')) {
        result.kind = 'anthropic';
        result.requires_credential = true;
        result.notes =
          'Anthropic-compatible endpoint detected. Auto-discovery of model ids is gated behind the API key — use the curated dropdown in Advanced (Sonnet/Opus/Haiku) or type a model id manually.';
        return result;
      }
      result.kind = 'openai-compatible';
      result.requires_credential = true;
      result.notes =
        'OpenAI-compatible endpoint detected (auth required). Save the API key as a OneCLI secret with hostPattern matching this URL, then assign here. ⚠ Using this kind requires the `/add-opencode` skill — the default Claude SDK does not speak OpenAI protocol.';
      return result;
    }
    if (r.ok) {
      const body = (await r.json()) as { data?: Array<{ id?: string }> };
      if (Array.isArray(body?.data)) {
        result.kind = 'openai-compatible';
        result.models = body.data.map((m) => m.id).filter((n): n is string => typeof n === 'string');
        result.notes = '⚠ Using OpenAI-compatible models requires the `/add-opencode` skill.';
        return result;
      }
    }
  } catch {
    // fall through
  }

  // 3. Anthropic-compatible — POST /v1/messages with empty body, expect 401 from real Anthropic
  try {
    const r = await safeFetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: '{}',
      signal: AbortSignal.timeout(4000),
    });
    if (r.status === 401 || r.status === 400) {
      // Real Anthropic returns 401 with "x-api-key required" or 400 missing fields.
      const body = await r.text();
      if (body.toLowerCase().includes('anthropic') || body.toLowerCase().includes('x-api-key')) {
        result.kind = 'anthropic';
        result.requires_credential = true;
        result.notes =
          "Anthropic-compatible endpoint detected. The model_id list isn't auto-discoverable for this kind — type the desired Anthropic model name manually (Sonnet/Opus/Haiku).";
        return result;
      }
    }
  } catch {
    // fall through
  }

  result.reason = `No known provider responded at ${base}. Tried /api/tags, /v1/models, /v1/messages.`;
  return result;
}
