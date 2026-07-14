/**
 * MCP health + drift sweep (items 3+4 of the MCP hardening review).
 *
 * Hourly (timer in index.ts), for every REMOTE server assigned to at least one
 * agent: re-probe as a real MCP client and record health; re-hash the tool
 * surface against the pin taken at attach time and flag drift — the "rug pull"
 * a server performs by mutating tool descriptions after approval. No shipped
 * first-party client does this; the reference implementation is mcp-scan's
 * hash pinning, which we mirror server-side.
 *
 * Drift NEVER auto-detaches: agents keep working (the operator may well want
 * the updated tools) — but the surface change is loud in the MCP tab until a
 * human re-approves it. Stdio servers run inside containers and can't be
 * probed from here; they're skipped.
 */
import { log } from '../../log.js';
import { effectiveAuthHeader } from './mcp-auth.js';
import { probeMcpEndpoint } from './mcp-probe.js';
import {
  diffToolSurface,
  getAgentsAssignedToMcpServer,
  hashToolSurface,
  listWebchatMcpServers,
  pinMcpToolSurface,
  setMcpServerDrift,
  setMcpServerHealth,
  type McpToolPin,
  type WebchatMcpServer,
} from './mcp-registry.js';

export interface McpHealth {
  status: 'ok' | 'down' | 'auth' | 'drift';
  at: number;
  reason?: string;
  toolCount?: number;
}

async function probeHeaders(server: WebchatMcpServer): Promise<Record<string, string>> {
  let headers: Record<string, string> = {};
  try {
    headers = server.headers ? (JSON.parse(server.headers) as Record<string, string>) : {};
  } catch {
    /* malformed */
  }
  const auth = await effectiveAuthHeader(server);
  if (auth) headers['Authorization'] = auth;
  return headers;
}

/** Probe one server, update its health/drift columns. Returns the health. */
export async function checkMcpServer(server: WebchatMcpServer): Promise<McpHealth> {
  const probe = await probeMcpEndpoint(server.url!, await probeHeaders(server));
  if (!probe.transport) {
    const health: McpHealth = {
      status: probe.requiresAuth ? 'auth' : 'down',
      at: Date.now(),
      reason: probe.reason,
    };
    setMcpServerHealth(server.id, health as unknown as Record<string, unknown>);
    return health;
  }
  const tools: McpToolPin[] = probe.tools.map((t) => ({ name: t.name, description: t.description }));
  let pin: { hash: string; tools: McpToolPin[] } | null = null;
  try {
    pin = server.pinned_tools ? (JSON.parse(server.pinned_tools) as { hash: string; tools: McpToolPin[] }) : null;
  } catch {
    pin = null;
  }
  if (!pin) {
    // First sight of this server's surface (pre-hardening row, or created
    // without a probe): this baseline is the approval.
    pinMcpToolSurface(server.id, tools);
    const health: McpHealth = { status: 'ok', at: Date.now(), toolCount: tools.length };
    setMcpServerHealth(server.id, health as unknown as Record<string, unknown>);
    return health;
  }
  if (hashToolSurface(tools) !== pin.hash) {
    const drift = diffToolSurface(pin.tools, tools);
    setMcpServerDrift(server.id, drift);
    const health: McpHealth = { status: 'drift', at: Date.now(), toolCount: tools.length };
    setMcpServerHealth(server.id, health as unknown as Record<string, unknown>);
    log.warn('MCP tool surface drifted from its pin', {
      server: server.name,
      added: drift?.added,
      removed: drift?.removed,
      changed: drift?.changed,
    });
    return health;
  }
  setMcpServerDrift(server.id, null);
  const health: McpHealth = { status: 'ok', at: Date.now(), toolCount: tools.length };
  setMcpServerHealth(server.id, health as unknown as Record<string, unknown>);
  return health;
}

/** One sweep pass over every assigned remote server. Returns servers checked. */
export async function sweepMcpHealth(): Promise<number> {
  const servers = listWebchatMcpServers().filter(
    (s) => s.transport !== 'stdio' && s.url && getAgentsAssignedToMcpServer(s.id).length > 0,
  );
  for (const s of servers) {
    try {
      await checkMcpServer(s);
    } catch (err) {
      log.warn('MCP health check threw', { server: s.name, err: String(err) });
    }
  }
  return servers.length;
}
