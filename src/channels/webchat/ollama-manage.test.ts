import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./models.js', () => ({
  safeFetch: vi.fn(),
}));

import { safeFetch } from './models.js';
import {
  _resetPullsForTest,
  getPullsSnapshot,
  getRosterRefreshState,
  listHostModels,
  parseConfiguredHosts,
  startPull,
} from './ollama-manage.js';

const mockFetch = vi.mocked(safeFetch);

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function ndjsonStream(lines: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(l + '\n'));
      controller.close();
    },
  });
  return { ok: true, status: 200, body: stream } as unknown as Response;
}

beforeEach(() => {
  mockFetch.mockReset();
  _resetPullsForTest();
});

describe('listHostModels', () => {
  it('merges /api/tags with /api/ps loaded state', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonRes({ models: [{ name: 'gemma4:latest', size: 9_600_000_000 }, { name: 'qwen3.5:4b', size: 3_400_000_000 }] }))
      .mockResolvedValueOnce(jsonRes({ models: [{ name: 'gemma4:latest', size_vram: 2_500_000_000 }] }));
    const models = await listHostModels('http://192.168.1.90:11434/');
    expect(models).toHaveLength(2);
    const gemma = models.find((m) => m.name === 'gemma4:latest')!;
    expect(gemma.loaded).toBe(true);
    expect(gemma.size_vram).toBe(2_500_000_000);
    expect(models.find((m) => m.name === 'qwen3.5:4b')!.loaded).toBe(false);
    // trailing slash stripped before path append
    expect(mockFetch.mock.calls[0][0]).toBe('http://192.168.1.90:11434/api/tags');
  });

  it('tolerates a host without /api/ps', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonRes({ models: [{ name: 'a', size: 1 }] }))
      .mockRejectedValueOnce(new Error('404'));
    const models = await listHostModels('http://h:11434');
    expect(models[0].loaded).toBe(false);
  });
});

describe('startPull', () => {
  it('tracks progress from the NDJSON stream and finishes on success', async () => {
    mockFetch.mockResolvedValueOnce(
      ndjsonStream([
        JSON.stringify({ status: 'pulling manifest' }),
        JSON.stringify({ status: 'pulling 4f0…', completed: 50, total: 100 }),
        JSON.stringify({ status: 'pulling 4f0…', completed: 100, total: 100 }),
        JSON.stringify({ status: 'success' }),
      ]),
    );
    const job = await startPull('http://h:11434', 'ornith');
    await vi.waitFor(() => expect(job.status).toBe('success'));
    expect(job.total).toBe(100);
    expect(job.completed).toBe(100);
    expect(job.finishedAt).not.toBeNull();
  });

  it('marks the job failed on an Ollama error line', async () => {
    mockFetch.mockResolvedValueOnce(ndjsonStream([JSON.stringify({ error: 'pull model manifest: file does not exist' })]));
    const job = await startPull('http://h:11434', 'no-such-model');
    await vi.waitFor(() => expect(job.status).toBe('error'));
    expect(job.error).toMatch(/does not exist/);
  });

  it('fails when the stream ends without a success status (dropped connection)', async () => {
    mockFetch.mockResolvedValueOnce(ndjsonStream([JSON.stringify({ status: 'pulling 4f0…', completed: 1, total: 100 })]));
    const job = await startPull('http://h:11434', 'ornith');
    await vi.waitFor(() => expect(job.status).toBe('error'));
    expect(job.error).toMatch(/ended early/);
  });

  it('dedupes a second click while the same pull is running', async () => {
    // A stream that never closes keeps the first job in 'pulling'.
    const hanging = new ReadableStream<Uint8Array>({ start() {} });
    mockFetch.mockResolvedValue({ ok: true, status: 200, body: hanging } as unknown as Response);
    const a = await startPull('http://h:11434', 'ornith');
    const b = await startPull('http://h:11434', 'ornith');
    expect(b).toBe(a);
    expect(getPullsSnapshot()).toHaveLength(1);
  });

  it('propagates an SSRF-gate rejection synchronously', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Blocked hostname: metadata.google.internal'));
    await expect(startPull('http://metadata.google.internal', 'x')).rejects.toThrow(/Blocked hostname/);
    expect(getPullsSnapshot()[0].status).toBe('error');
  });
});

describe('parseConfiguredHosts', () => {
  it('reads the gen-config header comment', () => {
    expect(parseConfiguredHosts('# Generated…\n# hosts: http://a:11434, http://b:11434\nmodel_list:\n')).toBe(
      'http://a:11434,http://b:11434',
    );
  });
  it('returns null when absent', () => {
    expect(parseConfiguredHosts('model_list: []\n')).toBeNull();
  });
});

describe('getRosterRefreshState', () => {
  it('reports unavailable when the litellm skill is not installed', () => {
    expect(getRosterRefreshState('/nonexistent-root').available).toBe(false);
  });
});

describe('computeRouterMetrics', () => {
  const NOW = 1_783_200_000_000;
  const line = (o: object) => JSON.stringify(o);
  it('counts per served model, splits live/shadow, excludes escalations from model counts', async () => {
    const { computeRouterMetrics } = await import('./ollama-manage.js');
    const text = [
      line({ ts: NOW, mode: 'live', route: 'code', final_model: 'ornith:latest' }),
      line({ ts: NOW, mode: 'live', route: 'escalate', final_model: '__escalate__' }),
      line({ ts: NOW, mode: 'shadow', route: 'general', requested_model: 'gemma4:latest' }),
      line({ ts: NOW, route: 'general', requested_model: 'gemma4:latest' }), // legacy, no mode
      line({ ts: NOW, mode: 'live', route: '__error__', final_model: 'gemma4:latest', error: 'ReadTimeout' }),
      line({ ts: NOW - 10 * 86_400_000, mode: 'live', route: 'code', final_model: 'old:1b' }), // outside window
      '{torn',
    ].join('\n');
    const m = computeRouterMetrics(text, 7, NOW + 1000);
    expect(m.total).toBe(5);
    expect(m.live).toBe(3);
    expect(m.errors).toBe(1);
    expect(m.escalations).toBe(1);
    expect(m.byModel.find((x) => x.model === 'gemma4:latest')!.count).toBe(3);
    expect(m.byModel.find((x) => x.model === 'ornith:latest')!.count).toBe(1);
    expect(m.byModel.some((x) => x.model === '__escalate__')).toBe(false);
    expect(m.byRoute[0].count).toBeGreaterThan(0);
  });
});
