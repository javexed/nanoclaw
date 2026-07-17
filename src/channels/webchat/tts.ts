/**
 * Webchat text-to-speech proxy.
 *
 * The PWA never talks to the TTS backend directly — it POSTs message text to
 * this host route, which forwards to a local, OpenAI-compatible speech
 * endpoint (Kokoro-FastAPI by default) and streams the audio back same-origin.
 * Routing through the host is what makes TTS work over Tailscale/remote access
 * too: the browser only ever needs to reach the webchat origin, never the
 * backend's loopback-bound port.
 *
 * Backend contract: `POST {endpoint}/v1/audio/speech` with an OpenAI-shaped
 * body (`{ model, voice, input, response_format }`) returning raw audio.
 * Kokoro-FastAPI, OpenAI's TTS, and any compatible server all satisfy it, so
 * the same route serves whichever the operator points `WEBCHAT_TTS_ENDPOINT`
 * at. Install the local Kokoro backend with the `/add-webchat-tts` skill.
 *
 * Config (all via .env, surfaced through env-load.ts):
 *   WEBCHAT_TTS_ENABLED    "true" turns the feature on (default off)
 *   WEBCHAT_TTS_ENDPOINT   backend base URL (default http://127.0.0.1:8880)
 *   WEBCHAT_TTS_MODEL      model name sent to the backend (default "kokoro")
 *   WEBCHAT_TTS_VOICE      default voice (default "af_heart")
 *
 * The play control appears only when the OWNER enables Read aloud for the
 * workspace (webchat_settings.read_aloud_enabled, default off — see
 * getReadAloudEnabled / migration 133). Once on: with a backend configured the
 * PWA uses it; with `enabled:false` it falls back to the browser's Web Speech
 * API (device voices). Off at the workspace level = no control at all.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { getReadAloudEnabled } from './db.js';

import { log } from '../../log.js';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8880';
const DEFAULT_MODEL = 'kokoro';
const DEFAULT_VOICE = 'af_heart';

// Assistant replies are short; cap generously and reject the pathological case
// (a paste-bomb) rather than stream megabytes of synthesized audio.
const MAX_INPUT_CHARS = 4000;
const REQUEST_BODY_LIMIT = 64 * 1024;
// Cold-load of the model on first synthesis can be slow; keep the ceiling high
// enough that a legitimate first request survives it.
const SYNTH_TIMEOUT_MS = 30_000;

function isEnabled(): boolean {
  return process.env.WEBCHAT_TTS_ENABLED === 'true';
}
export function ttsEndpoint(): string {
  return (process.env.WEBCHAT_TTS_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, '');
}
function model(): string {
  return process.env.WEBCHAT_TTS_MODEL || DEFAULT_MODEL;
}
function defaultVoice(): string {
  return process.env.WEBCHAT_TTS_VOICE || DEFAULT_VOICE;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBoundedBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      body += d;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * Handle the two TTS routes. Returns true if the request was one of ours (and
 * a response was written), false to let the caller fall through to its other
 * routes. Call this AFTER the auth gate — synthesis and config are both
 * authenticated, same as every other /api/* route.
 */
export async function maybeHandleTts(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
): Promise<boolean> {
  // Capability probe — the PWA fetches this at boot to decide whether to show
  // the server-backed play control (enabled) or fall back to Web Speech.
  if (url.pathname === '/api/tts/config' && method === 'GET') {
    sendJson(res, 200, {
      enabled: isEnabled(),
      voice: defaultVoice(),
      model: process.env.WEBCHAT_TTS_MODEL || 'kokoro',
      readAloud: getReadAloudEnabled(),
    });
    return true;
  }

  if (url.pathname === '/api/tts' && method === 'POST') {
    // CSRF: the custom header a cross-origin simple request can't set, matching
    // every other JSON POST. Ambient auth (Tailscale whois) makes this a real
    // gate, not decoration.
    if (req.headers['x-webchat-csrf'] !== '1') {
      sendJson(res, 403, { error: 'Missing X-Webchat-CSRF header' });
      return true;
    }
    if (!isEnabled()) {
      sendJson(res, 503, { error: 'TTS not enabled' });
      return true;
    }

    let raw: string;
    try {
      raw = await readBoundedBody(req, REQUEST_BODY_LIMIT);
    } catch {
      sendJson(res, 413, { error: 'Request body too large' });
      return true;
    }

    let body: { text?: unknown; voice?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return true;
    }

    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      sendJson(res, 400, { error: 'text is required' });
      return true;
    }
    if (text.length > MAX_INPUT_CHARS) {
      sendJson(res, 413, { error: `text exceeds ${MAX_INPUT_CHARS} characters` });
      return true;
    }
    const voice = typeof body.voice === 'string' && body.voice.trim() ? body.voice.trim() : defaultVoice();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SYNTH_TIMEOUT_MS);
    try {
      const upstream = await fetch(`${ttsEndpoint()}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model(), voice, input: text, response_format: 'mp3' }),
        signal: controller.signal,
      });
      if (!upstream.ok || !upstream.body) {
        const detail = await upstream.text().catch(() => '');
        log.warn('Webchat TTS backend error', { status: upstream.status, detail: detail.slice(0, 200) });
        sendJson(res, 502, { error: 'TTS synthesis failed' });
        return true;
      }
      // Buffer then send: assistant replies are short (a few seconds of audio,
      // typically well under a megabyte), so a single write is simpler and more
      // robust across Node/undici stream-piping quirks than plumbing the web
      // ReadableStream through to the socket.
      const audio = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': audio.length,
        'Cache-Control': 'no-store',
      });
      res.end(audio);
      return true;
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      log.warn('Webchat TTS proxy failed', { err: String(err), aborted });
      if (!res.headersSent) {
        sendJson(res, aborted ? 504 : 502, {
          error: aborted ? 'TTS synthesis timed out' : 'TTS backend unreachable',
        });
      }
      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  return false;
}
