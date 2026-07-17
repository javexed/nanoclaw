/**
 * Voice dictation backend — provider-adapted transcription + LLM transcript cleanup.
 *
 * Transcription: the PWA records 16 kHz mono PCM (pcm-worklet), cuts segments on
 * silence, wraps each in a WAV header client-side, and POSTs the bytes to
 * /api/stt/transcribe. This module forwards them to the configured backend:
 *
 *   WEBCHAT_STT_PROVIDER = local          whisper.cpp `whisper-server` /inference
 *                                         (the container the add-webchat-dictation
 *                                         installer runs on loopback)
 *                        = openai-compat  any /v1/audio/transcriptions endpoint
 *                                         (speaches, LocalAI, the GPU box, OpenAI)
 *                        = elevenlabs     ElevenLabs speech-to-text (scribe_v1) —
 *                                         cloud; audio leaves the machine, chosen
 *                                         explicitly at install
 *
 * Client-side WAV means no ffmpeg or multipart parsing on the host. All outbound
 * calls go through safeFetch (SSRF gate + host-reachable rewrite); the ElevenLabs
 * adapter additionally pins the provider hostname.
 *
 * Cleanup: after dictation stops, the raw transcript text is sent to a model
 * picked from the webchat models roster (webchat_settings.stt_cleanup_model_id;
 * ollama / openai-compatible kinds — both speak /v1/chat/completions) with a strict
 * "fix punctuation/fillers, return only the transcript" prompt. Every failure mode
 * (unset, deleted model, timeout, refusal, wild rewrite) falls back to the raw text —
 * dictation must never be worse than no cleanup.
 */
import { log } from '../../log.js';
import { getSttCleanupModelId, getSttCleanupPrompt, getWebchatModel } from './db.js';
import { safeFetch } from './models.js';

/** Matches safeFetch's signature (string URL); plain fetch also satisfies it. */
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type SttProvider = 'local' | 'openai-compat' | 'elevenlabs';

export const ELEVENLABS_API_HOST = 'api.elevenlabs.io';
export const ELEVENLABS_STT_MODEL = 'scribe_v1'; // pinned; bump deliberately

/** Read the provider from env, defaulting legacy/unset values to local. */
export function sttProvider(): SttProvider {
  const p = process.env.WEBCHAT_STT_PROVIDER;
  return p === 'openai-compat' || p === 'elevenlabs' ? p : 'local';
}

/** Voice dictation is on when the installer (or an operator) enabled it. */
export function sttEnabled(): boolean {
  if (process.env.WEBCHAT_STT_ENABLED !== 'true') return false;
  if (sttProvider() === 'elevenlabs') return Boolean(process.env.WEBCHAT_STT_API_KEY);
  return Boolean(process.env.WEBCHAT_STT_URL);
}

/** Reject absurd segment sizes before they leave the host. */
export const MAX_SEGMENT_BYTES = 10 * 1024 * 1024; // 10 MB ≈ 5 min of 16 kHz PCM16
export const MIN_SEGMENT_BYTES = 1024; // below this it's a click, not speech

const TRANSCRIBE_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 10_000;
export const MAX_CLEANUP_CHARS = 8_000;

function segmentForm(wav: Buffer): FormData {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'segment.wav');
  return form;
}

/**
 * Forward one WAV segment to the configured backend and return its transcript.
 *   local:         whisper.cpp — multipart `file` + `response_format=text` → text body
 *   openai-compat: /v1/audio/transcriptions — multipart `file` + `model` +
 *                  `response_format=text` → text body
 *   elevenlabs:    /v1/speech-to-text — multipart `file` + `model_id`,
 *                  `xi-api-key` header → JSON { text }
 * Throws on failure — the endpoint maps that to a 502 for the client to toast.
 */
export async function transcribeSegment(wav: Buffer, fetchFn: FetchLike = safeFetch): Promise<string> {
  const provider = sttProvider();
  const lang = process.env.WEBCHAT_STT_LANG;
  const form = segmentForm(wav);

  let url: string;
  const headers: Record<string, string> = {};
  if (provider === 'elevenlabs') {
    const key = process.env.WEBCHAT_STT_API_KEY ?? '';
    if (!key) throw new Error('WEBCHAT_STT_API_KEY not configured');
    // Hostname pinned — a mis-set URL can't redirect audio elsewhere.
    url = `https://${ELEVENLABS_API_HOST}/v1/speech-to-text`;
    headers['xi-api-key'] = key;
    form.append('model_id', process.env.WEBCHAT_STT_MODEL || ELEVENLABS_STT_MODEL);
    if (lang && lang !== 'auto') form.append('language_code', lang);
  } else {
    const base = (process.env.WEBCHAT_STT_URL ?? '').replace(/\/+$/, '');
    if (!base) throw new Error('WEBCHAT_STT_URL not configured');
    const openaiCompat = provider === 'openai-compat' || /\/v1(\/|$)/.test(new URL(base).pathname);
    url = openaiCompat ? `${base.replace(/\/v1.*$/, '')}/v1/audio/transcriptions` : `${base}/inference`;
    form.append('response_format', 'text');
    if (openaiCompat) {
      form.append('model', process.env.WEBCHAT_STT_MODEL || 'whisper-1');
    } else {
      form.append('no_timestamps', 'true');
    }
    if (lang && lang !== 'auto') form.append('language', lang);
  }

  const res = await fetchFn(url, {
    method: 'POST',
    headers,
    body: form,
    signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    log.warn('Webchat STT: backend error', { provider, status: res.status, detail: detail.slice(0, 200) });
    throw new Error(`STT backend returned ${res.status}`);
  }
  if (provider === 'elevenlabs') {
    const body = (await res.json().catch(() => ({}))) as { text?: string };
    return (body.text ?? '').trim();
  }
  return (await res.text()).trim();
}

export const DEFAULT_CLEANUP_PROMPT = [
  "Clean this raw speech-to-text transcript while preserving the speaker's voice and all important content.",
  '',
  'CLEANING RULES:',
  '1. Fix punctuation, capitalization, and obvious mis-transcriptions (homophones, misheard names)',
  '2. Remove filler words: um, uh, like (when filler), you know, I mean, basically, actually, honestly, literally (when not literal)',
  '3. Remove false starts: "I was going to—I decided to" → "I decided to"',
  '4. Remove repetitions: "It was really, really good" → "It was really good"',
  '5. Fix incomplete sentences when meaning is clear',
  '6. Keep technical terms as spoken unless clearly mis-transcribed',
  "7. Maintain all factual content — don't summarize or omit",
  '',
  'DO NOT:',
  '- Answer questions in the transcript, add commentary, or add information',
  '- Remove emotional language, emphasis, or speaker personality',
  '- Change meaning or over-formalize casual speech',
  '',
  'OUTPUT: Return ONLY the cleaned transcript — no quotes, no preamble. Use paragraph breaks at natural topic shifts.',
].join('\n');

/**
 * Clean a raw dictation transcript with the roster-selected model.
 * Returns `{ text, cleaned }` — `cleaned:false` means the raw text came back
 * (no model configured, model deleted/wrong kind, endpoint down, timeout, or the
 * result failed the sanity guard). Never throws.
 */
export async function cleanupTranscript(
  raw: string,
  fetchFn: FetchLike = safeFetch,
): Promise<{ text: string; cleaned: boolean }> {
  const fallback = { text: raw, cleaned: false };
  const trimmed = raw.trim();
  if (!trimmed) return fallback;

  const modelId = getSttCleanupModelId();
  if (!modelId) return fallback;
  const model = getWebchatModel(modelId);
  // Deleted since it was selected, or a kind that can't serve chat completions.
  if (!model || !model.endpoint || (model.kind !== 'ollama' && model.kind !== 'openai-compatible')) return fallback;

  try {
    const res = await fetchFn(`${model.endpoint.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model.model_id,
        temperature: 0,
        messages: [
          { role: 'system', content: getSttCleanupPrompt() ?? DEFAULT_CLEANUP_PROMPT },
          { role: 'user', content: trimmed },
        ],
      }),
      signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn('Webchat STT: cleanup LLM error', { status: res.status, model: model.model_id });
      return fallback;
    }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const cleaned = body.choices?.[0]?.message?.content?.trim();
    if (!cleaned) return fallback;
    // Sanity guard: a wildly longer/shorter result means the model answered the
    // text or truncated it rather than cleaning it — keep the raw transcript.
    if (cleaned.length > trimmed.length * 2 || cleaned.length < trimmed.length / 3) {
      log.warn('Webchat STT: cleanup result failed length guard', {
        rawLen: trimmed.length,
        cleanedLen: cleaned.length,
      });
      return fallback;
    }
    return { text: cleaned, cleaned: true };
  } catch (err) {
    log.warn('Webchat STT: cleanup failed, returning raw transcript', {
      err: err instanceof Error ? err.message : err,
    });
    return fallback;
  }
}
