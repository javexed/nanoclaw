/**
 * Agent drafter — turn a freeform prompt into a suggested
 * { name, instructions } pair for a new agent.
 *
 * Host-side LLM call routed through the OneCLI gateway. Containers do the
 * exact same routing (HTTPS_PROXY pointing at OneCLI, OneCLI injects the
 * Anthropic auth at request time); we re-use that mechanism so the host
 * never holds the raw API key in usable form. The drafter is registered
 * with OneCLI as its own agent identifier so its proxy slot is auditable
 * separately from any other host activity.
 *
 * Why host-side instead of container-side: a previous iteration spawned
 * a dedicated drafter container, which needed a per-agent tool-denylist
 * (otherwise the agent SDK happily calls `mcp__nanoclaw__create_agent`
 * to instantiate the agent it was just asked to draft). The denylist
 * required a trunk change. Host-side has no agent-SDK in the loop —
 * it's just a plain HTTP call with a fixed prompt — so there's nothing
 * to lock down.
 */
import fs from 'fs';
import { OneCLI, OneCLIRequestError } from '@onecli-sh/sdk';
import { ProxyAgent } from 'undici';

import { log } from '../../log.js';

// Reserved agent identifier registered with OneCLI on first draft request.
// `[a-z][a-z0-9-]{0,49}` per OneCLI's identifier regex — same gotcha that
// bit us with random UUIDs in the prior drafter container attempt.
const DRAFTER_AGENT_ID = 'webchat-drafter';
const DRAFTER_AGENT_NAME = 'Agent Drafter';

// Haiku — fast + cheap, more than capable of producing a one-shot JSON
// agent definition. Drafter latency matters more than model nuance here.
// Env-overridable so an operator can shift to a different model when this
// one is deprecated, without waiting for a code release.
const DRAFTER_MODEL = process.env.WEBCHAT_DRAFTER_MODEL || 'claude-haiku-4-5';
const DRAFTER_MAX_TOKENS = 2048;

// Cap response size *before* JSON.parse — Anthropic's max_tokens already
// caps it server-side, but a misbehaving proxy or upstream could in
// principle return more. 16 KB is far above any honest 2048-token reply.
const MAX_RESPONSE_BYTES = 16 * 1024;

// Cache the OneCLI-derived transport so a busy operator clicking ✨ many
// times doesn't page the gateway on every request. 5 minutes matches the
// PWA's typical session interval.
const TRANSPORT_CACHE_MS = 5 * 60 * 1000;
// Throttle bootstrap retries when OneCLI is consistently unreachable so
// repeated drafts don't fan out to OneCLI as fast as the user can click.
const BOOTSTRAP_RETRY_BACKOFF_MS = 30 * 1000;

const DRAFTER_SYSTEM_PROMPT = `You are an agent-definition drafter for the NanoClaw assistant platform. Given a description of what the user wants their assistant to do, return ONE JSON object describing it. NOTHING ELSE — no prose, no markdown, no code fences, no explanation.

Schema:
{"name": "<short human-friendly label, ≤ 64 chars>", "instructions": "<plain markdown system prompt, ≤ 1800 chars, written in second person ('You are…'), focused on tone, scope, and behavior>"}

Rules:
- ALWAYS respond, even for thin or unclear input — infer something reasonable.
- Never ask clarifying questions. The caller is a programmatic request.
- "name" should read like a recognizable label — Title Case is fine (e.g., "Code Reviewer", "Recipe Helper").
- "instructions" should read like a CLAUDE.md system prompt: define purpose, tone, and scope. No framing prose like "Here is your assistant:" — just the prompt itself.
- Do NOT include placeholder text like "<your instructions here>".
- Properly escape quotes and newlines inside the JSON string values.
- Output the JSON object now. Begin with { and end with }. No other characters.`;

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PROMPT_LENGTH = 2000;
const MAX_NAME_LENGTH = 64;
const MAX_INSTRUCTIONS_LENGTH = 2048;

// Single shared OneCLI client + lazy bootstrap promise — match the trunk
// pattern in container-runner.ts:48.
const ONECLI_URL = process.env.ONECLI_URL || 'http://127.0.0.1:10254';
const ONECLI_API_KEY = process.env.ONECLI_API_KEY || '';
const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

let bootstrapPromise: Promise<void> | null = null;
let bootstrapNextAttemptAfter = 0; // epoch ms; bootstrap calls before this short-circuit
let requestQueue: Promise<unknown> = Promise.resolve();
// Cached transport — populated by buildDrafterTransport, expires on a
// timer or on a 401 from Anthropic (cache likely stale; rebuild).
interface CachedTransport {
  dispatcher: ProxyAgent;
  authHeaders: Record<string, string>;
  expiresAt: number;
}
let cachedTransport: CachedTransport | null = null;

export class DraftError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export interface DraftedAgent {
  name: string;
  instructions: string;
}

/**
 * Idempotently register the drafter identifier with OneCLI on first use.
 * Subsequent calls share the in-flight promise. Per the v2 CLAUDE.md OneCLI
 * gotcha, freshly-created identifiers start in `selective` secret mode and
 * 401 on the first call — operators must run
 *   onecli agents set-secret-mode --id webchat-drafter --mode all
 * once. Documented in SKILL.md.
 */
function ensureDrafterIdentity(): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise;
  // Throttle: if a recent bootstrap failed, fail fast for the cooldown
  // window instead of fanning out OneCLI calls as the user retries.
  if (Date.now() < bootstrapNextAttemptAfter) {
    return Promise.reject(new DraftError('OneCLI gateway unreachable; retry in a few seconds', 503));
  }
  bootstrapPromise = onecli
    .ensureAgent({ name: DRAFTER_AGENT_NAME, identifier: DRAFTER_AGENT_ID })
    .then(() => {
      log.info('Webchat drafter identity registered with OneCLI', { identifier: DRAFTER_AGENT_ID });
    })
    .catch((err) => {
      bootstrapPromise = null; // allow retry on next call
      bootstrapNextAttemptAfter = Date.now() + BOOTSTRAP_RETRY_BACKOFF_MS;
      throw err;
    });
  return bootstrapPromise;
}

/**
 * Build an undici dispatcher + auth headers for an Anthropic call routed
 * through the OneCLI proxy.
 *
 * OneCLI's auth model (worked out empirically):
 *   - `getContainerConfig(identifier)` returns a per-agent proxy URL with
 *     an `aoc_*` token in userinfo, plus a CA cert.
 *   - The proxy expects requests to carry an `Authorization: Bearer <env>`
 *     header where `<env>` is the literal value of CLAUDE_CODE_OAUTH_TOKEN
 *     (which is just the placeholder string). The proxy swaps the
 *     placeholder for the real token before forwarding to Anthropic.
 *   - The `anthropic-beta: oauth-2025-04-20` header is required for the
 *     OAuth-style auth path to be accepted.
 *
 * Inside containers `cfg.env.HTTPS_PROXY` points at `host.docker.internal`;
 * on the host that doesn't resolve, so we rewrite to `127.0.0.1`. The
 * `NODE_EXTRA_CA_CERTS` env path likewise points at the in-container path
 * (`/tmp/onecli-gateway-ca.pem`), so we use the inline `cfg.caCertificate`
 * string instead.
 */
async function buildDrafterTransport(): Promise<{
  dispatcher: ProxyAgent;
  authHeaders: Record<string, string>;
}> {
  if (cachedTransport && cachedTransport.expiresAt > Date.now()) {
    return { dispatcher: cachedTransport.dispatcher, authHeaders: cachedTransport.authHeaders };
  }
  const cfg = await onecli.getContainerConfig(DRAFTER_AGENT_ID);
  const rawProxy = cfg.env.HTTPS_PROXY ?? cfg.env.HTTP_PROXY;
  if (!rawProxy) throw new DraftError('OneCLI gateway returned no proxy URL', 503);
  // replaceAll handles the (rare) case where host.docker.internal appears
  // in more than one position of the URI, e.g., a redirect query param.
  const proxyUri = rawProxy.replaceAll('host.docker.internal', '127.0.0.1');

  // Always prefer the inline string — the env path is in-container only.
  // Fall back to reading the path if for some reason caCertificate is empty.
  let ca: Buffer;
  if (cfg.caCertificate) {
    ca = Buffer.from(cfg.caCertificate);
  } else if (cfg.env.NODE_EXTRA_CA_CERTS && fs.existsSync(cfg.env.NODE_EXTRA_CA_CERTS)) {
    ca = fs.readFileSync(cfg.env.NODE_EXTRA_CA_CERTS);
  } else {
    throw new DraftError('OneCLI gateway returned no CA certificate', 503);
  }

  const dispatcher = new ProxyAgent({ uri: proxyUri, requestTls: { ca } });
  const placeholderToken = cfg.env.CLAUDE_CODE_OAUTH_TOKEN ?? 'placeholder';
  const authHeaders: Record<string, string> = {
    authorization: `Bearer ${placeholderToken}`,
    'anthropic-beta': 'oauth-2025-04-20',
  };
  cachedTransport = { dispatcher, authHeaders, expiresAt: Date.now() + TRANSPORT_CACHE_MS };
  return { dispatcher, authHeaders };
}

/** Drop the cached transport — invoked on 401 (likely stale token / mode). */
function invalidateTransportCache(): void {
  cachedTransport = null;
}

/**
 * Run a draft request through the queue. Serialized — concurrent callers
 * wait their turn so we don't fan out parallel Anthropic calls under one
 * proxy slot.
 */
export async function draftAgent(prompt: string): Promise<DraftedAgent> {
  const trimmed = (prompt ?? '').trim();
  if (!trimmed) throw new DraftError('Prompt required', 400);
  if (trimmed.length > MAX_PROMPT_LENGTH) {
    throw new DraftError(`Prompt too long (max ${MAX_PROMPT_LENGTH} chars)`, 400);
  }

  // Chain onto the queue, swallowing the previous request's rejection so it
  // doesn't poison subsequent calls.
  const myTurn = requestQueue.then(
    () => runDraft(trimmed),
    () => runDraft(trimmed),
  );
  requestQueue = myTurn.catch(() => undefined);
  return myTurn;
}

async function runDraft(prompt: string): Promise<DraftedAgent> {
  await ensureDrafterIdentity();
  const { dispatcher, authHeaders } = await buildDrafterTransport();

  const body = {
    model: DRAFTER_MODEL,
    max_tokens: DRAFTER_MAX_TOKENS,
    system: DRAFTER_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  };

  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...authHeaders,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // Type cast: undici's dispatcher option isn't in the standard fetch
      // typings, but Node's global fetch accepts it at runtime.
      dispatcher,
    } as RequestInit & { dispatcher: ProxyAgent });
  } catch (err) {
    // Log full detail server-side so an operator can debug; surface a
    // generic message to the caller so internal IPs / proxy URLs don't
    // leak through the error response.
    log.warn('Webchat drafter: fetch threw', { err });
    if (err instanceof OneCLIRequestError) {
      throw new DraftError('Drafter call failed (OneCLI gateway error)', err.statusCode || 503);
    }
    throw new DraftError('Drafter call failed (see server logs)', 503);
  }

  if (res.status === 401) {
    // Stale auth — drop cache so the next attempt rebuilds the transport.
    invalidateTransportCache();
    throw new DraftError(
      'OneCLI rejected the drafter call (401). The drafter agent likely starts in selective secret mode — find its internal id with `onecli agents list` and run: onecli agents set-secret-mode --id <internal-id> --mode all',
      503,
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    log.warn('Webchat drafter: non-OK response', { status: res.status, detail: detail.slice(0, 500) });
    throw new DraftError(`Drafter upstream returned ${res.status}`, 502);
  }

  // Read response as text first so we can size-cap before JSON.parse.
  // 16 KB is far above what max_tokens=2048 can produce, but caps a
  // misbehaving upstream from filling memory if it ever happens.
  const rawResponseText = await res.text();
  if (rawResponseText.length > MAX_RESPONSE_BYTES) {
    throw new DraftError('Drafter upstream returned an oversized response', 502);
  }
  let responseBody: { content?: Array<{ type: string; text?: string }> };
  try {
    responseBody = JSON.parse(rawResponseText);
  } catch {
    throw new DraftError('Drafter upstream returned non-JSON response', 502);
  }
  const text = (responseBody.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
    .trim();
  if (!text) throw new DraftError('Drafter returned empty content', 502);
  return parseDraftResponse(text);
}

function parseDraftResponse(rawText: string): DraftedAgent {
  const cleaned = stripCodeFence(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new DraftError('Drafter returned non-JSON response', 502);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new DraftError('Drafter response not a JSON object', 502);
  }
  const obj = parsed as { name?: unknown; instructions?: unknown };
  if (typeof obj.name !== 'string' || typeof obj.instructions !== 'string') {
    throw new DraftError('Drafter response missing name or instructions', 502);
  }
  // Strip control characters (TAB and LF survive — the LLM might use them
  // legitimately inside instructions). Names get a stricter pass: no
  // newlines or other control chars at all so they can't break log
  // formats / flat outputs / URL paths.
  const name = stripControlChars(obj.name, { allowNewlines: false }).trim();
  const instructions = stripControlChars(obj.instructions, { allowNewlines: true }).trim();
  if (!name) throw new DraftError('Drafter returned empty name', 502);
  if (!instructions) throw new DraftError('Drafter returned empty instructions', 502);
  if (name.length > MAX_NAME_LENGTH) {
    throw new DraftError(`Drafter name too long (>${MAX_NAME_LENGTH} chars)`, 502);
  }
  if (instructions.length > MAX_INSTRUCTIONS_LENGTH) {
    throw new DraftError(`Drafter instructions too long (>${MAX_INSTRUCTIONS_LENGTH} chars)`, 502);
  }
  return { name, instructions };
}

function stripControlChars(s: string, opts: { allowNewlines: boolean }): string {
  // Strip ASCII control characters (U+0000-U+001F + U+007F DEL). When
  // allowNewlines is set, preserve LF (U+000A) and CR (U+000D) so a
  // multi-line `instructions` value survives intact.
  // eslint-disable-next-line no-control-regex
  const allControl = /[\x00-\x1f\x7f]/g;
  // eslint-disable-next-line no-control-regex
  const exceptNewlines = /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g;
  return s.replace(opts.allowNewlines ? exceptNewlines : allControl, '');
}

function stripCodeFence(s: string): string {
  // Belt-and-suspenders: tolerate the LLM occasionally wrapping output in
  // ```json fences even though the system prompt forbids it.
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i;
  const m = s.match(fence);
  return m ? m[1].trim() : s;
}
