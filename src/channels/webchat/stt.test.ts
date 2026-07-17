/**
 * Voice dictation backend: whisper forwarding + LLM transcript cleanup.
 * Fetch is injected everywhere — no network. DB-backed bits (cleanup model
 * selection) run against the migrated in-memory test DB.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { transcribeSegment, cleanupTranscript, sttEnabled, sttProvider, ELEVENLABS_STT_MODEL } from './stt.js';
import { createWebchatModel, getSttCleanupModelId, setSttCleanupModelId, getSttCleanupPrompt, setSttCleanupPrompt } from './db.js';

const WAV = Buffer.alloc(4096, 1);

function fakeFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: string }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const { status = 200, body } = handler(url, init);
    return new Response(body, { status });
  };
  return { fn, calls };
}

function addModel(id: string, kind: string, endpoint: string | null = 'http://127.0.0.1:11434'): void {
  createWebchatModel({
    id,
    name: id,
    kind: kind as never,
    endpoint,
    model_id: 'llama3.2:3b',
    credential_ref: null,
    created_at: Date.now(),
  });
}

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
  for (const k of ['WEBCHAT_STT_ENABLED', 'WEBCHAT_STT_PROVIDER', 'WEBCHAT_STT_URL', 'WEBCHAT_STT_LANG', 'WEBCHAT_STT_MODEL', 'WEBCHAT_STT_API_KEY']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  closeDb();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('sttEnabled / sttProvider', () => {
  it('requires the enable flag AND a provider-appropriate config', () => {
    expect(sttEnabled()).toBe(false);
    process.env.WEBCHAT_STT_ENABLED = 'true';
    expect(sttEnabled()).toBe(false); // no URL yet
    process.env.WEBCHAT_STT_URL = 'http://127.0.0.1:8771';
    expect(sttEnabled()).toBe(true);
  });

  it('elevenlabs needs the API key, not a URL', () => {
    process.env.WEBCHAT_STT_ENABLED = 'true';
    process.env.WEBCHAT_STT_PROVIDER = 'elevenlabs';
    expect(sttEnabled()).toBe(false);
    process.env.WEBCHAT_STT_API_KEY = 'xi-test';
    expect(sttEnabled()).toBe(true);
  });

  it('unknown provider values fall back to local', () => {
    process.env.WEBCHAT_STT_PROVIDER = 'whisper'; // legacy/typo
    expect(sttProvider()).toBe('local');
  });
});

describe('transcribeSegment', () => {
  it('posts multipart WAV to whisper.cpp /inference and returns trimmed text', async () => {
    process.env.WEBCHAT_STT_URL = 'http://127.0.0.1:8080';
    const { fn, calls } = fakeFetch(() => ({ body: '  hello world \n' }));
    expect(await transcribeSegment(WAV, fn)).toBe('hello world');
    expect(calls[0].url).toBe('http://127.0.0.1:8080/inference');
    const form = calls[0].init?.body as FormData;
    expect(form.get('response_format')).toBe('text');
    expect(form.get('no_timestamps')).toBe('true');
    expect(form.get('file')).toBeInstanceOf(Blob);
  });

  it('uses the OpenAI-compatible audio/transcriptions shape when the URL path has /v1', async () => {
    process.env.WEBCHAT_STT_URL = 'http://127.0.0.1:9000/v1';
    process.env.WEBCHAT_STT_MODEL = 'Systran/faster-whisper-base';
    const { fn, calls } = fakeFetch(() => ({ body: 'hi' }));
    await transcribeSegment(WAV, fn);
    expect(calls[0].url).toBe('http://127.0.0.1:9000/v1/audio/transcriptions');
    const form = calls[0].init?.body as FormData;
    expect(form.get('model')).toBe('Systran/faster-whisper-base');
    expect(form.get('no_timestamps')).toBeNull(); // whisper.cpp-only field
  });

  it('forwards WEBCHAT_STT_LANG when set', async () => {
    process.env.WEBCHAT_STT_URL = 'http://127.0.0.1:8080';
    process.env.WEBCHAT_STT_LANG = 'en';
    const { fn, calls } = fakeFetch(() => ({ body: 'x' }));
    await transcribeSegment(WAV, fn);
    expect((calls[0].init?.body as FormData).get('language')).toBe('en');
  });

  it('throws on a non-200 from the whisper endpoint', async () => {
    process.env.WEBCHAT_STT_URL = 'http://127.0.0.1:8080';
    const { fn } = fakeFetch(() => ({ status: 500, body: 'boom' }));
    await expect(transcribeSegment(WAV, fn)).rejects.toThrow(/500/);
  });

  it('throws when WEBCHAT_STT_URL is unset', async () => {
    const { fn } = fakeFetch(() => ({ body: 'x' }));
    await expect(transcribeSegment(WAV, fn)).rejects.toThrow(/not configured/);
  });
});

describe('transcribeSegment — elevenlabs', () => {
  beforeEach(() => {
    process.env.WEBCHAT_STT_PROVIDER = 'elevenlabs';
    process.env.WEBCHAT_STT_API_KEY = 'xi-test-key';
  });

  it('posts to the pinned host with xi-api-key and parses JSON text', async () => {
    const { fn, calls } = fakeFetch(() => ({ body: JSON.stringify({ text: ' hello from the cloud ' }) }));
    expect(await transcribeSegment(WAV, fn)).toBe('hello from the cloud');
    expect(calls[0].url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect((calls[0].init?.headers as Record<string, string>)['xi-api-key']).toBe('xi-test-key');
    const form = calls[0].init?.body as FormData;
    expect(form.get('model_id')).toBe(ELEVENLABS_STT_MODEL);
    expect(form.get('response_format')).toBeNull(); // local-only field
  });

  it('maps language codes and skips auto', async () => {
    process.env.WEBCHAT_STT_LANG = 'auto';
    const { fn, calls } = fakeFetch(() => ({ body: '{"text":"x"}' }));
    await transcribeSegment(WAV, fn);
    expect((calls[0].init?.body as FormData).get('language_code')).toBeNull();
    process.env.WEBCHAT_STT_LANG = 'nl';
    const { fn: fn2, calls: calls2 } = fakeFetch(() => ({ body: '{"text":"x"}' }));
    await transcribeSegment(WAV, fn2);
    expect((calls2[0].init?.body as FormData).get('language_code')).toBe('nl');
  });

  it('throws without an API key and on provider errors', async () => {
    delete process.env.WEBCHAT_STT_API_KEY;
    const { fn } = fakeFetch(() => ({ body: '{}' }));
    await expect(transcribeSegment(WAV, fn)).rejects.toThrow(/not configured/);
    process.env.WEBCHAT_STT_API_KEY = 'xi-test-key';
    const { fn: err } = fakeFetch(() => ({ status: 401, body: 'bad key' }));
    await expect(transcribeSegment(WAV, err)).rejects.toThrow(/401/);
  });
});

describe('cleanupTranscript', () => {
  const RAW = 'um so i think we should uh ship the thing tomorrow';

  it('returns raw when no cleanup model is configured (no fetch)', async () => {
    const { fn, calls } = fakeFetch(() => ({ body: '{}' }));
    expect(await cleanupTranscript(RAW, fn)).toEqual({ text: RAW, cleaned: false });
    expect(calls).toHaveLength(0);
  });

  it('returns raw when the configured model was deleted', async () => {
    setSttCleanupModelId('gone-model');
    const { fn, calls } = fakeFetch(() => ({ body: '{}' }));
    expect(await cleanupTranscript(RAW, fn)).toEqual({ text: RAW, cleaned: false });
    expect(calls).toHaveLength(0);
  });

  it('returns raw for a model kind that cannot serve chat completions', async () => {
    addModel('m-anthropic', 'anthropic', null);
    setSttCleanupModelId('m-anthropic');
    const { fn, calls } = fakeFetch(() => ({ body: '{}' }));
    expect(await cleanupTranscript(RAW, fn)).toEqual({ text: RAW, cleaned: false });
    expect(calls).toHaveLength(0);
  });

  it('cleans via the roster model: right URL, model id, temperature 0, strict prompt', async () => {
    addModel('m-ollama', 'ollama');
    setSttCleanupModelId('m-ollama');
    const cleaned = 'I think we should ship the thing tomorrow.';
    const { fn, calls } = fakeFetch(() => ({
      body: JSON.stringify({ choices: [{ message: { content: cleaned } }] }),
    }));
    expect(await cleanupTranscript(RAW, fn)).toEqual({ text: cleaned, cleaned: true });
    expect(calls[0].url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    const req = JSON.parse(String(calls[0].init?.body));
    expect(req.model).toBe('llama3.2:3b');
    expect(req.temperature).toBe(0);
    expect(req.messages[0].role).toBe('system');
    expect(req.messages[0].content).toMatch(/ONLY the cleaned transcript/);
    expect(req.messages[1]).toEqual({ role: 'user', content: RAW });
  });

  it('rejects a wild rewrite via the length guard (model answered instead of cleaning)', async () => {
    addModel('m-ollama', 'ollama');
    setSttCleanupModelId('m-ollama');
    const essay = 'Shipping tomorrow is a great idea because '.repeat(10);
    const { fn } = fakeFetch(() => ({
      body: JSON.stringify({ choices: [{ message: { content: essay } }] }),
    }));
    expect(await cleanupTranscript(RAW, fn)).toEqual({ text: RAW, cleaned: false });
  });

  it('falls back to raw on endpoint failure and on empty content', async () => {
    addModel('m-ollama', 'ollama');
    setSttCleanupModelId('m-ollama');
    const { fn: err } = fakeFetch(() => ({ status: 502, body: 'down' }));
    expect(await cleanupTranscript(RAW, err)).toEqual({ text: RAW, cleaned: false });
    const { fn: empty } = fakeFetch(() => ({ body: JSON.stringify({ choices: [{ message: { content: '' } }] }) }));
    expect(await cleanupTranscript(RAW, empty)).toEqual({ text: RAW, cleaned: false });
  });
});

describe('cleanup prompt override', () => {
  const RAW = 'nano clot dictation test';

  it('uses the stored custom prompt as the system message', async () => {
    addModel('m-ollama', 'ollama');
    setSttCleanupModelId('m-ollama');
    setSttCleanupPrompt('Custom prompt: fix NanoClaw names.');
    const { fn, calls } = fakeFetch(() => ({
      body: JSON.stringify({ choices: [{ message: { content: 'NanoClaw dictation test' } }] }),
    }));
    await cleanupTranscript(RAW, fn);
    const req = JSON.parse(String(calls[0].init?.body));
    expect(req.messages[0].content).toBe('Custom prompt: fix NanoClaw names.');
  });

  it('falls back to the built-in default when unset/blank', async () => {
    addModel('m-ollama', 'ollama');
    setSttCleanupModelId('m-ollama');
    setSttCleanupPrompt(null);
    expect(getSttCleanupPrompt()).toBeNull();
    setSttCleanupPrompt('   ');
    expect(getSttCleanupPrompt()).toBeNull(); // blank reads as unset
    const { fn, calls } = fakeFetch(() => ({
      body: JSON.stringify({ choices: [{ message: { content: 'Nano clot dictation test.' } }] }),
    }));
    await cleanupTranscript(RAW, fn);
    const req = JSON.parse(String(calls[0].init?.body));
    expect(req.messages[0].content).toMatch(/ONLY the cleaned transcript/);
  });
});

describe('stt_cleanup_model_id (migration + accessors)', () => {
  it('adds the column; defaults to null; set/clear roundtrips', () => {
    const cols = (getDb().prepare("PRAGMA table_info('webchat_settings')").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain('stt_cleanup_model_id');
    expect(getSttCleanupModelId()).toBeNull();
    setSttCleanupModelId('m-1');
    expect(getSttCleanupModelId()).toBe('m-1');
    setSttCleanupModelId(null);
    expect(getSttCleanupModelId()).toBeNull();
  });
});
