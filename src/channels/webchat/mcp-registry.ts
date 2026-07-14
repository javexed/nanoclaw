/**
 * MCP server registry — DB layer + container-config sync.
 *
 * Mirrors the models registry (db.ts §Models) but for MCP servers, with a
 * many-to-many assignment (an agent can have several servers; one server can
 * be wired to several agents).
 *
 * Sync model: the registry rows are the GUI's source of truth; the agent's
 * container reads container_configs.mcp_servers (the same JSON column `ncl
 * groups config add-mcp-server` edits). On assign/unassign we upsert/delete
 * ONLY the assigned server's own key in that JSON — never a wholesale
 * recompute — so ncl-added servers with names outside the registry survive.
 */
import { createHash, randomUUID } from 'crypto';

import type { McpServerConfig } from '../../container-config.js';
import { getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { getDb } from '../../db/connection.js';

export type WebchatMcpTransport = 'stdio' | 'sse' | 'http';

export interface WebchatMcpServer {
  id: string;
  name: string;
  transport: WebchatMcpTransport;
  command: string | null;
  args: string | null; // JSON string[]
  env: string | null; // JSON Record<string,string>
  url: string | null;
  headers: string | null; // JSON Record<string,string>
  instructions: string | null;
  created_at: number;
  // MCP hardening (migration webchat-mcp-hardening) — all JSON, all nullable.
  health: string | null; // {status:'ok'|'down'|'auth'|'drift', at, reason?, toolCount?}
  pinned_tools: string | null; // {hash, at, tools:[{name,description}]}
  drift: string | null; // {at, added:[], removed:[], changed:[]}
  enabled_tools: string | null; // string[] — allowlist, null = all tools
  auth: string | null; // {kind:'bearer'|'oauth', token?, oauth?:{...}} — host-side only
}

export interface McpToolPin {
  name: string;
  description: string;
}

export interface McpDrift {
  at: number;
  added: string[];
  removed: string[];
  changed: string[];
}

/** Stable hash of a tool surface: order-independent, name+description only. */
export function hashToolSurface(tools: McpToolPin[]): string {
  const canon = [...tools]
    .map((t) => ({ name: t.name, description: t.description || '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

/** Pin a server's tool surface — the operator-approved baseline for drift checks. */
export function pinMcpToolSurface(id: string, tools: McpToolPin[]): void {
  const pin = { hash: hashToolSurface(tools), at: Date.now(), tools };
  getDb().prepare(`UPDATE webchat_mcp_servers SET pinned_tools = ?, drift = NULL WHERE id = ?`).run(
    JSON.stringify(pin),
    id,
  );
}

/** Diff a freshly probed surface against the pin. Null = no drift. */
export function diffToolSurface(pinned: McpToolPin[], current: McpToolPin[]): McpDrift | null {
  const p = new Map(pinned.map((t) => [t.name, t.description || '']));
  const c = new Map(current.map((t) => [t.name, t.description || '']));
  const added = [...c.keys()].filter((n) => !p.has(n)).sort();
  const removed = [...p.keys()].filter((n) => !c.has(n)).sort();
  const changed = [...c.keys()].filter((n) => p.has(n) && p.get(n) !== c.get(n)).sort();
  if (!added.length && !removed.length && !changed.length) return null;
  return { at: Date.now(), added, removed, changed };
}

export function setMcpServerHealth(id: string, health: Record<string, unknown>): void {
  getDb().prepare(`UPDATE webchat_mcp_servers SET health = ? WHERE id = ?`).run(JSON.stringify(health), id);
}

export function setMcpServerDrift(id: string, drift: McpDrift | null): void {
  getDb()
    .prepare(`UPDATE webchat_mcp_servers SET drift = ? WHERE id = ?`)
    .run(drift ? JSON.stringify(drift) : null, id);
}

export function setMcpServerEnabledTools(id: string, tools: string[] | null): void {
  getDb()
    .prepare(`UPDATE webchat_mcp_servers SET enabled_tools = ? WHERE id = ?`)
    .run(tools ? JSON.stringify(tools) : null, id);
}

export function setMcpServerAuth(id: string, auth: Record<string, unknown> | null): void {
  getDb()
    .prepare(`UPDATE webchat_mcp_servers SET auth = ? WHERE id = ?`)
    .run(auth ? JSON.stringify(auth) : null, id);
}

export interface WebchatMcpServerInput {
  name: string;
  transport: WebchatMcpTransport;
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
  url?: string | null;
  headers?: Record<string, string>;
  instructions?: string | null;
}

export function listWebchatMcpServers(): WebchatMcpServer[] {
  return getDb().prepare(`SELECT * FROM webchat_mcp_servers ORDER BY name COLLATE NOCASE`).all() as WebchatMcpServer[];
}

export function getWebchatMcpServer(id: string): WebchatMcpServer | undefined {
  return getDb().prepare(`SELECT * FROM webchat_mcp_servers WHERE id = ?`).get(id) as WebchatMcpServer | undefined;
}

export function getWebchatMcpServerByName(name: string): WebchatMcpServer | undefined {
  return getDb().prepare(`SELECT * FROM webchat_mcp_servers WHERE name = ?`).get(name) as WebchatMcpServer | undefined;
}

export function createWebchatMcpServer(input: WebchatMcpServerInput): WebchatMcpServer {
  const row: WebchatMcpServer = {
    id: randomUUID(),
    name: input.name,
    transport: input.transport,
    command: input.command ?? null,
    args: input.args ? JSON.stringify(input.args) : null,
    env: input.env ? JSON.stringify(input.env) : null,
    url: input.url ?? null,
    headers: input.headers ? JSON.stringify(input.headers) : null,
    instructions: input.instructions ?? null,
    created_at: Date.now(),
    health: null,
    pinned_tools: null,
    drift: null,
    enabled_tools: null,
    auth: null,
  };
  getDb()
    .prepare(
      `INSERT INTO webchat_mcp_servers (id, name, transport, command, args, env, url, headers, instructions, created_at)
       VALUES (@id, @name, @transport, @command, @args, @env, @url, @headers, @instructions, @created_at)`,
    )
    .run(row);
  return row;
}

export function updateWebchatMcpServer(
  id: string,
  patch: Partial<Omit<WebchatMcpServerInput, 'name'>> & { name?: string },
): void {
  const existing = getWebchatMcpServer(id);
  if (!existing) return;
  const next = {
    name: patch.name ?? existing.name,
    transport: patch.transport ?? existing.transport,
    command: patch.command !== undefined ? patch.command : existing.command,
    args: patch.args !== undefined ? JSON.stringify(patch.args) : existing.args,
    env: patch.env !== undefined ? JSON.stringify(patch.env) : existing.env,
    url: patch.url !== undefined ? patch.url : existing.url,
    headers: patch.headers !== undefined ? JSON.stringify(patch.headers) : existing.headers,
    instructions: patch.instructions !== undefined ? patch.instructions : existing.instructions,
  };
  getDb()
    .prepare(
      `UPDATE webchat_mcp_servers
       SET name = ?, transport = ?, command = ?, args = ?, env = ?, url = ?, headers = ?, instructions = ?
       WHERE id = ?`,
    )
    .run(next.name, next.transport, next.command, next.args, next.env, next.url, next.headers, next.instructions, id);
}

export function deleteWebchatMcpServer(id: string): void {
  const db = getDb();
  // Cascade in JS — caller surfaces the impact list first (mirrors models).
  db.prepare(`DELETE FROM webchat_agent_mcp_servers WHERE mcp_server_id = ?`).run(id);
  db.prepare(`DELETE FROM webchat_mcp_servers WHERE id = ?`).run(id);
}

export function getAgentsAssignedToMcpServer(serverId: string): string[] {
  return (
    getDb().prepare(`SELECT agent_group_id FROM webchat_agent_mcp_servers WHERE mcp_server_id = ?`).all(serverId) as {
      agent_group_id: string;
    }[]
  ).map((r) => r.agent_group_id);
}

export function getMcpServersForAgent(agentGroupId: string): WebchatMcpServer[] {
  return getDb()
    .prepare(
      `SELECT s.* FROM webchat_mcp_servers s
       JOIN webchat_agent_mcp_servers a ON a.mcp_server_id = s.id
       WHERE a.agent_group_id = ?
       ORDER BY s.name COLLATE NOCASE`,
    )
    .all(agentGroupId) as WebchatMcpServer[];
}

export function assignMcpServerToAgent(agentGroupId: string, serverId: string): void {
  getDb()
    .prepare(
      `INSERT INTO webchat_agent_mcp_servers (agent_group_id, mcp_server_id, assigned_at)
       VALUES (?, ?, ?)
       ON CONFLICT(agent_group_id, mcp_server_id) DO NOTHING`,
    )
    .run(agentGroupId, serverId, Date.now());
}

export function unassignMcpServerFromAgent(agentGroupId: string, serverId: string): void {
  getDb()
    .prepare(`DELETE FROM webchat_agent_mcp_servers WHERE agent_group_id = ? AND mcp_server_id = ?`)
    .run(agentGroupId, serverId);
}

// The relay listens here (mcp-relay.ts imports this — keeping the constant on
// the registry side avoids a registry↔relay import cycle).
export const MCP_RELAY_PORT = Number(process.env.WEBCHAT_MCP_RELAY_PORT || 3102);

function parseEnabledTools(s: WebchatMcpServer): string[] | undefined {
  try {
    const t = s.enabled_tools ? (JSON.parse(s.enabled_tools) as string[]) : null;
    return Array.isArray(t) && t.length > 0 ? t : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Registry row → the McpServerConfig shape container_configs/containers use.
 * A remote server with host-side auth is rewritten to go through the relay:
 * the container gets the relay URL + a scoped relay token; the real credential
 * never appears in container.json (mcp-relay.ts injects it at forward time).
 */
export function mcpServerToConfig(s: WebchatMcpServer, relayToken?: string): McpServerConfig {
  const instructions = s.instructions ?? undefined;
  const enabledTools = parseEnabledTools(s);
  if (s.transport === 'stdio') {
    return {
      command: s.command ?? '',
      args: s.args ? (JSON.parse(s.args) as string[]) : [],
      env: s.env ? (JSON.parse(s.env) as Record<string, string>) : {},
      ...(instructions ? { instructions } : {}),
      ...(enabledTools ? { enabledTools } : {}),
    };
  }
  if (s.auth && relayToken) {
    return {
      type: 'http', // the relay speaks Streamable HTTP to the container side
      url: `http://host.docker.internal:${MCP_RELAY_PORT}/relay/${s.id}`,
      headers: { 'X-NanoClaw-Relay': relayToken },
      ...(instructions ? { instructions } : {}),
      ...(enabledTools ? { enabledTools } : {}),
    };
  }
  return {
    type: s.transport,
    url: s.url ?? '',
    headers: s.headers ? (JSON.parse(s.headers) as Record<string, string>) : {},
    ...(instructions ? { instructions } : {}),
    ...(enabledTools ? { enabledTools } : {}),
  };
}

/** Get-or-mint the relay token for one (agent group, server) assignment. */
export function ensureRelayToken(agentGroupId: string, serverId: string): string | null {
  const row = getDb()
    .prepare(`SELECT relay_token FROM webchat_agent_mcp_servers WHERE agent_group_id = ? AND mcp_server_id = ?`)
    .get(agentGroupId, serverId) as { relay_token: string | null } | undefined;
  if (!row) return null;
  if (row.relay_token) return row.relay_token;
  const token = `mcr_${randomUUID().replace(/-/g, '')}`;
  getDb()
    .prepare(`UPDATE webchat_agent_mcp_servers SET relay_token = ? WHERE agent_group_id = ? AND mcp_server_id = ?`)
    .run(token, agentGroupId, serverId);
  return token;
}

/**
 * Upsert/remove ONE server's key in an agent group's container_configs
 * .mcp_servers JSON. Incremental on purpose — see the header comment.
 * Returns false when the group has no container config row.
 */
export function syncAgentMcpConfig(agentGroupId: string, server: WebchatMcpServer, present: boolean): boolean {
  const row = getContainerConfig(agentGroupId);
  if (!row) return false;
  const servers = JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
  if (present) {
    const relayToken = server.auth ? ensureRelayToken(agentGroupId, server.id) : null;
    servers[server.name] = mcpServerToConfig(server, relayToken ?? undefined);
  } else {
    delete servers[server.name];
  }
  updateContainerConfigJson(agentGroupId, 'mcp_servers', servers);
  return true;
}
