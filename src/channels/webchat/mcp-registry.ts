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
import { randomUUID } from 'crypto';

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

/** Registry row → the McpServerConfig shape container_configs/containers use. */
export function mcpServerToConfig(s: WebchatMcpServer): McpServerConfig {
  const instructions = s.instructions ?? undefined;
  if (s.transport === 'stdio') {
    return {
      command: s.command ?? '',
      args: s.args ? (JSON.parse(s.args) as string[]) : [],
      env: s.env ? (JSON.parse(s.env) as Record<string, string>) : {},
      ...(instructions ? { instructions } : {}),
    };
  }
  return {
    type: s.transport,
    url: s.url ?? '',
    headers: s.headers ? (JSON.parse(s.headers) as Record<string, string>) : {},
    ...(instructions ? { instructions } : {}),
  };
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
  if (present) servers[server.name] = mcpServerToConfig(server);
  else delete servers[server.name];
  updateContainerConfigJson(agentGroupId, 'mcp_servers', servers);
  return true;
}
