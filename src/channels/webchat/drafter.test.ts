/**
 * Drafter contract tests. Mocks `@onecli-sh/sdk` and global fetch so the
 * tests run without OneCLI or network. Each scenario re-imports the
 * module via `vi.resetModules()` to reset its module-level state
 * (bootstrap promise, transport cache, request queue, retry backoff).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

interface MockedOneCLI {
  ensureAgent: ReturnType<typeof vi.fn>;
  getContainerConfig: ReturnType<typeof vi.fn>;
}

let mockOneCLIInstance: MockedOneCLI;
let fetchMock: ReturnType<typeof vi.fn>;

/**
 * Minimal happy-path container config. Mirrors the shape returned by the
 * real SDK enough for buildDrafterTransport to succeed.
 */
function happyCfg(): {
  env: Record<string, string>;
  caCertificate: string;
} {
  return {
    env: {
      HTTPS_PROXY: 'http://host.docker.internal:10254',
      CLAUDE_CODE_OAUTH_TOKEN: 'placeholder',
    },
    caCertificate: '-----BEGIN CERTIFICATE-----\nMIIBmoc=\n-----END CERTIFICATE-----',
  };
}

/**
 * Build an Anthropic-shaped JSON response wrapping a single text block.
 * Used for the happy-path fetch mock.
 */
function anthropicResponse(text: string, status = 200): Response {
  return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function jsonString(name: string, instructions: string): string {
  return JSON.stringify({ name, instructions });
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  mockOneCLIInstance = {
    ensureAgent: vi.fn().mockResolvedValue(undefined),
    getContainerConfig: vi.fn().mockResolvedValue(happyCfg()),
  };
  vi.doMock('@onecli-sh/sdk', () => ({
    OneCLI: class OneCLI {
      ensureAgent: typeof mockOneCLIInstance.ensureAgent;
      getContainerConfig: typeof mockOneCLIInstance.getContainerConfig;
      constructor() {
        this.ensureAgent = mockOneCLIInstance.ensureAgent;
        this.getContainerConfig = mockOneCLIInstance.getContainerConfig;
      }
    },
    OneCLIRequestError: class OneCLIRequestError extends Error {
      statusCode: number;
      constructor(msg: string, statusCode = 503) {
        super(msg);
        this.statusCode = statusCode;
      }
    },
  }));
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

async function importDrafter(): Promise<typeof import('./drafter.js')> {
  return import('./drafter.js');
}

describe('draftAgent — input validation', () => {
  it('rejects empty prompt with 400', async () => {
    const { draftAgent, DraftError } = await importDrafter();
    await expect(draftAgent('')).rejects.toBeInstanceOf(DraftError);
    await expect(draftAgent('  \t ')).rejects.toMatchObject({ status: 400 });
  });

  it('rejects oversized prompt (>2000 chars) with 400', async () => {
    const { draftAgent } = await importDrafter();
    await expect(draftAgent('x'.repeat(2001))).rejects.toMatchObject({ status: 400 });
  });
});

describe('draftAgent — happy path', () => {
  it('returns parsed { name, instructions } from a clean Anthropic response', async () => {
    fetchMock.mockResolvedValueOnce(anthropicResponse(jsonString('Code Reviewer', 'You review code.')));
    const { draftAgent } = await importDrafter();
    const result = await draftAgent('a code review agent');
    expect(result).toEqual({ name: 'Code Reviewer', instructions: 'You review code.' });
    expect(mockOneCLIInstance.ensureAgent).toHaveBeenCalledTimes(1);
    expect(mockOneCLIInstance.getContainerConfig).toHaveBeenCalledTimes(1);
  });

  it('strips ```json fences before parsing', async () => {
    const fenced = '```json\n' + jsonString('Recipe Helper', 'You suggest recipes.') + '\n```';
    fetchMock.mockResolvedValueOnce(anthropicResponse(fenced));
    const { draftAgent } = await importDrafter();
    const result = await draftAgent('recipes');
    expect(result.name).toBe('Recipe Helper');
  });
});

describe('draftAgent — bootstrap caching + retry backoff', () => {
  it('shares the bootstrap promise across concurrent calls', async () => {
    // Each fetch call needs a fresh Response — bodies can only be read once.
    fetchMock.mockImplementation(() => Promise.resolve(anthropicResponse(jsonString('A', 'A'))));
    const { draftAgent } = await importDrafter();
    await Promise.all([draftAgent('one'), draftAgent('two'), draftAgent('three')]);
    // ensureAgent called exactly once even with 3 concurrent drafts.
    expect(mockOneCLIInstance.ensureAgent).toHaveBeenCalledTimes(1);
  });

  it('after a bootstrap failure, fast-fails further calls during the backoff window', async () => {
    mockOneCLIInstance.ensureAgent.mockRejectedValueOnce(new Error('OneCLI down'));
    const { draftAgent } = await importDrafter();
    // First call: triggers bootstrap, fails.
    await expect(draftAgent('foo')).rejects.toThrow();
    // Immediate retry should NOT call ensureAgent again — backoff.
    await expect(draftAgent('bar')).rejects.toMatchObject({ status: 503 });
    expect(mockOneCLIInstance.ensureAgent).toHaveBeenCalledTimes(1);
  });
});

describe('draftAgent — transport caching', () => {
  it('reuses the cached transport across calls within the cache window', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(anthropicResponse(jsonString('A', 'A'))));
    const { draftAgent } = await importDrafter();
    await draftAgent('one');
    await draftAgent('two');
    // getContainerConfig should be called once for the first transport
    // build; second call hits the cache.
    expect(mockOneCLIInstance.getContainerConfig).toHaveBeenCalledTimes(1);
  });

  it('rebuilds transport on 401 (cache invalidated)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(anthropicResponse(jsonString('A', 'A')));
    const { draftAgent } = await importDrafter();
    await expect(draftAgent('first')).rejects.toMatchObject({ status: 503 });
    // Second call: cache was invalidated on 401, so we fetch container
    // config again before issuing the request.
    await draftAgent('second');
    expect(mockOneCLIInstance.getContainerConfig).toHaveBeenCalledTimes(2);
  });
});

describe('draftAgent — error mapping', () => {
  it('maps fetch network errors to a generic 503 (no internal detail in message)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:10254'));
    const { draftAgent } = await importDrafter();
    const err = await draftAgent('hi').catch((e) => e);
    expect(err.status).toBe(503);
    // Internal IP/port must not surface in the user-facing message.
    expect(String(err.message)).not.toContain('127.0.0.1');
    expect(String(err.message)).not.toContain('ECONNREFUSED');
  });

  it('maps non-OK upstream response to 502 with a generic message', async () => {
    fetchMock.mockResolvedValueOnce(new Response('rate limited', { status: 429 }));
    const { draftAgent } = await importDrafter();
    const err = await draftAgent('hi').catch((e) => e);
    expect(err.status).toBe(502);
    expect(String(err.message)).toContain('429');
  });

  it('maps OneCLI 401 to a 503 with the secret-mode hint', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));
    const { draftAgent } = await importDrafter();
    const err = await draftAgent('hi').catch((e) => e);
    expect(err.status).toBe(503);
    expect(String(err.message)).toContain('selective secret mode');
  });

  it('rejects oversized upstream responses before JSON.parse', async () => {
    // Far above the 16KB cap.
    const huge = 'x'.repeat(20000);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ content: [{ type: 'text', text: huge }] }), { status: 200 }),
    );
    const { draftAgent } = await importDrafter();
    const err = await draftAgent('hi').catch((e) => e);
    expect(err.status).toBe(502);
    expect(String(err.message)).toContain('oversized');
  });

  it('rejects non-JSON upstream responses', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json at all', { status: 200 }));
    const { draftAgent } = await importDrafter();
    await expect(draftAgent('hi')).rejects.toMatchObject({ status: 502 });
  });
});

describe('draftAgent — drafter response validation', () => {
  it('rejects responses missing `name` or `instructions`', async () => {
    fetchMock.mockResolvedValueOnce(anthropicResponse(JSON.stringify({ name: 'OK' /* instructions missing */ })));
    const { draftAgent } = await importDrafter();
    await expect(draftAgent('x')).rejects.toMatchObject({ status: 502 });
  });

  it('rejects empty name after trimming', async () => {
    fetchMock.mockResolvedValueOnce(anthropicResponse(jsonString('   ', 'something')));
    const { draftAgent } = await importDrafter();
    await expect(draftAgent('x')).rejects.toMatchObject({ status: 502 });
  });

  it('rejects oversized name after parsing', async () => {
    fetchMock.mockResolvedValueOnce(anthropicResponse(jsonString('x'.repeat(100), 'short')));
    const { draftAgent } = await importDrafter();
    await expect(draftAgent('x')).rejects.toMatchObject({ status: 502 });
  });

  it('strips control characters from name (no newlines allowed)', async () => {
    fetchMock.mockResolvedValueOnce(anthropicResponse(jsonString('Foo\x00\x07Bar', 'instructions')));
    const { draftAgent } = await importDrafter();
    const result = await draftAgent('x');
    expect(result.name).toBe('FooBar');
  });

  it('preserves newlines in instructions but strips other control chars', async () => {
    fetchMock.mockResolvedValueOnce(anthropicResponse(jsonString('Helper', 'line one\nline two\x00with junk')));
    const { draftAgent } = await importDrafter();
    const result = await draftAgent('x');
    expect(result.instructions).toBe('line one\nline twowith junk');
  });
});

describe('draftAgent — env override', () => {
  it('honors WEBCHAT_DRAFTER_MODEL', async () => {
    vi.stubEnv('WEBCHAT_DRAFTER_MODEL', 'claude-sonnet-4-6');
    fetchMock.mockResolvedValueOnce(anthropicResponse(jsonString('A', 'A')));
    const { draftAgent } = await importDrafter();
    await draftAgent('hello');
    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(callBody.model).toBe('claude-sonnet-4-6');
  });
});
