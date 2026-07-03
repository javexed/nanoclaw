/**
 * MCP endpoint probe — connect to a remote MCP server as a real client and
 * list its tools, so the operator can verify a URL before saving it to the
 * registry (the MCP twin of models.ts's probeEndpoint).
 *
 * Transport detection: try Streamable HTTP first (the current spec transport),
 * fall back to SSE (legacy but still common — e.g. supergateway-wrapped stdio
 * servers). Whichever handshake completes wins and is reported back so the
 * create form can pre-select it.
 *
 * Security: the URL is operator input — every attempt goes through the same
 * SSRF gate as the models probe (assertSafeOutboundUrl: blocks link-local/
 * metadata/0.0.0.0, honours WEBCHAT_BLOCK_PRIVATE_IPS). Loopback/RFC1918/
 * CGNAT stay allowed by default: tailnet tool boxes are the primary use case.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { assertSafeOutboundUrl } from './models.js';

export interface McpProbeResult {
  /** Transport that completed the handshake; null when nothing responded. */
  transport: 'http' | 'sse' | null;
  endpoint: string;
  serverName?: string;
  serverVersion?: string;
  tools: { name: string; description: string }[];
  /** Why the probe failed (transport === null). */
  reason?: string;
}

const PROBE_TIMEOUT_MS = 8000;

async function probeOne(url: string, kind: 'http' | 'sse', headers: Record<string, string>): Promise<McpProbeResult> {
  const client = new Client({ name: 'nanoclaw-webchat-probe', version: '1.0.0' });
  const target = new URL(url);
  const requestInit = Object.keys(headers).length ? { headers } : undefined;
  const transport =
    kind === 'http'
      ? new StreamableHTTPClientTransport(target, { requestInit })
      : new SSEClientTransport(target, { requestInit });
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Timed out after ${PROBE_TIMEOUT_MS / 1000}s`)), PROBE_TIMEOUT_MS),
  );
  try {
    await Promise.race([client.connect(transport), timeout]);
    const listed = await Promise.race([client.listTools(), timeout]);
    const info = client.getServerVersion();
    return {
      transport: kind,
      endpoint: url,
      serverName: info?.name,
      serverVersion: info?.version,
      tools: (listed.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? '' })),
    };
  } finally {
    // Best-effort teardown — a half-open handshake must not leak sockets.
    await client.close().catch(() => {});
  }
}

/**
 * Probe a URL as an MCP server. Tries Streamable HTTP then SSE, sequentially
 * (they hit the same endpoint; racing both doubles load on a maybe-slow box
 * for no latency win — the HTTP attempt fails fast on SSE-only servers).
 */
export async function probeMcpEndpoint(rawUrl: string, headers: Record<string, string> = {}): Promise<McpProbeResult> {
  const url = rawUrl.trim().replace(/\/+$/, '');
  await assertSafeOutboundUrl(url);
  const reasons: string[] = [];
  for (const kind of ['http', 'sse'] as const) {
    try {
      return await probeOne(url, kind, headers);
    } catch (err) {
      reasons.push(`${kind}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {
    transport: null,
    endpoint: url,
    tools: [],
    reason: `No MCP server responded. ${reasons.join(' · ')}`,
  };
}
