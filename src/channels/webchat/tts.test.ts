import { EventEmitter } from 'events';
import type { IncomingMessage, ServerResponse } from 'http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { maybeHandleTts } from './tts.js';

function makeRes() {
  let status = 0;
  let headers: Record<string, unknown> = {};
  const chunks: unknown[] = [];
  const res = {
    headersSent: false,
    writeHead(s: number, h?: Record<string, unknown>) {
      status = s;
      if (h) headers = h;
      res.headersSent = true;
      return res;
    },
    end(data?: unknown) {
      if (data !== undefined) chunks.push(data);
      return res;
    },
  };
  return {
    res: res as unknown as ServerResponse,
    get status() {
      return status;
    },
    get headers() {
      return headers;
    },
    body() {
      const raw = chunks[0];
      if (typeof raw === 'string') {
        try {
          return JSON.parse(raw);
        } catch {
          return raw;
        }
      }
      return raw;
    },
  };
}

// A GET request needs no body stream; a POST emits its body then ends.
function makeReq(body?: string, headers: Record<string, string> = { 'x-webchat-csrf': '1' }): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage & { destroy: () => void };
  (req as unknown as { destroy: () => void }).destroy = () => {};
  (req as unknown as { headers: Record<string, string> }).headers = headers;
  if (body !== undefined) {
    queueMicrotask(() => {
      req.emit('data', Buffer.from(body));
      req.emit('end');
    });
  }
  return req;
}

const OLD_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.restoreAllMocks();
});

describe('maybeHandleTts', () => {
  it('ignores unrelated routes', async () => {
    const { res } = makeRes();
    const handled = await maybeHandleTts(makeReq(), res, new URL('http://x/api/rooms'), 'GET');
    expect(handled).toBe(false);
  });

  it('config probe reports disabled by default', async () => {
    delete process.env.WEBCHAT_TTS_ENABLED;
    const cap = makeRes();
    const handled = await maybeHandleTts(makeReq(), cap.res, new URL('http://x/api/tts/config'), 'GET');
    expect(handled).toBe(true);
    expect(cap.status).toBe(200);
    expect(cap.body()).toMatchObject({ enabled: false });
  });

  it('config probe reports enabled + voice when configured', async () => {
    process.env.WEBCHAT_TTS_ENABLED = 'true';
    process.env.WEBCHAT_TTS_VOICE = 'am_adam';
    const cap = makeRes();
    await maybeHandleTts(makeReq(), cap.res, new URL('http://x/api/tts/config'), 'GET');
    expect(cap.body()).toEqual({ enabled: true, voice: 'am_adam', model: 'kokoro', readAloud: false });
  });

  it('rejects a synthesis POST without the CSRF header', async () => {
    process.env.WEBCHAT_TTS_ENABLED = 'true';
    const cap = makeRes();
    const handled = await maybeHandleTts(makeReq('{"text":"hi"}', {}), cap.res, new URL('http://x/api/tts'), 'POST');
    expect(handled).toBe(true);
    expect(cap.status).toBe(403);
  });

  it('rejects synthesis when disabled', async () => {
    delete process.env.WEBCHAT_TTS_ENABLED;
    const cap = makeRes();
    const handled = await maybeHandleTts(makeReq('{"text":"hi"}'), cap.res, new URL('http://x/api/tts'), 'POST');
    expect(handled).toBe(true);
    expect(cap.status).toBe(503);
  });

  it('rejects empty text', async () => {
    process.env.WEBCHAT_TTS_ENABLED = 'true';
    const cap = makeRes();
    await maybeHandleTts(makeReq('{"text":"   "}'), cap.res, new URL('http://x/api/tts'), 'POST');
    expect(cap.status).toBe(400);
  });

  it('proxies to the backend and streams audio back', async () => {
    process.env.WEBCHAT_TTS_ENABLED = 'true';
    process.env.WEBCHAT_TTS_ENDPOINT = 'http://127.0.0.1:8880';
    const audio = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      body: {},
      arrayBuffer: async () => audio.buffer,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const cap = makeRes();
    const handled = await maybeHandleTts(
      makeReq('{"text":"hello world"}'),
      cap.res,
      new URL('http://x/api/tts'),
      'POST',
    );
    expect(handled).toBe(true);
    expect(cap.status).toBe(200);
    expect(cap.headers['Content-Type']).toBe('audio/mpeg');
    // Backend called with the OpenAI-compatible speech shape.
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toBe('http://127.0.0.1:8880/v1/audio/speech');
    expect(JSON.parse(String(calledInit.body))).toMatchObject({ input: 'hello world', model: 'kokoro' });
  });

  it('returns 502 when the backend errors', async () => {
    process.env.WEBCHAT_TTS_ENABLED = 'true';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, body: null, text: async () => 'boom' })),
    );
    const cap = makeRes();
    await maybeHandleTts(makeReq('{"text":"hi"}'), cap.res, new URL('http://x/api/tts'), 'POST');
    expect(cap.status).toBe(502);
  });
});
