/**
 * MCP registry tests — CRUD, the many-to-many assignment join, and the
 * container-config sync invariant: syncAgentMcpConfig only ever touches the
 * one key it owns in container_configs.mcp_servers (an ncl-added server with
 * a different name must survive attach/detach cycles).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import type { McpServerConfig } from '../../container-config.js';
import {
  assignMcpServerToAgent,
  createWebchatMcpServer,
  deleteWebchatMcpServer,
  getAgentsAssignedToMcpServer,
  getMcpServersForAgent,
  getWebchatMcpServer,
  getWebchatMcpServerByName,
  listWebchatMcpServers,
  mcpServerToConfig,
  syncAgentMcpConfig,
  unassignMcpServerFromAgent,
  updateWebchatMcpServer,
} from './mcp-registry.js';

const GID = 'ag-mcp-test';

function seedAgentWithConfig(mcpServers: Record<string, McpServerConfig> = {}): void {
  createAgentGroup({ id: GID, name: 'mcp', folder: 'mcp', agent_provider: null, created_at: new Date().toISOString() });
  getDb()
    .prepare(
      `INSERT INTO container_configs
         (agent_group_id, provider, model, effort, image_tag, assistant_name, max_messages_per_prompt,
          skills, mcp_servers, packages_apt, packages_npm, additional_mounts, cli_scope, updated_at)
       VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, '"all"', ?, '[]', '[]', '[]', 'group', ?)`,
    )
    .run(GID, JSON.stringify(mcpServers), new Date().toISOString());
}

function configServers(): Record<string, McpServerConfig> {
  const row = getDb().prepare(`SELECT mcp_servers FROM container_configs WHERE agent_group_id = ?`).get(GID) as {
    mcp_servers: string;
  };
  return JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
}

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});

afterEach(() => {
  closeDb();
});

describe('mcp-registry CRUD', () => {
  it('creates, lists, fetches by id and name', () => {
    const s = createWebchatMcpServer({ name: 'windows', transport: 'sse', url: 'http://box:8000/sse' });
    expect(listWebchatMcpServers().map((r) => r.name)).toEqual(['windows']);
    expect(getWebchatMcpServer(s.id)?.url).toBe('http://box:8000/sse');
    expect(getWebchatMcpServerByName('windows')?.id).toBe(s.id);
  });

  it('updates fields and preserves the rest', () => {
    const s = createWebchatMcpServer({ name: 'w', transport: 'sse', url: 'http://a' });
    updateWebchatMcpServer(s.id, { url: 'http://b' });
    const after = getWebchatMcpServer(s.id);
    expect(after?.url).toBe('http://b');
    expect(after?.name).toBe('w');
    expect(after?.transport).toBe('sse');
  });

  it('delete cascades the assignment join', () => {
    seedAgentWithConfig();
    const s = createWebchatMcpServer({ name: 'x', transport: 'http', url: 'http://x' });
    assignMcpServerToAgent(GID, s.id);
    expect(getAgentsAssignedToMcpServer(s.id)).toEqual([GID]);
    deleteWebchatMcpServer(s.id);
    expect(getWebchatMcpServer(s.id)).toBeUndefined();
    expect(getAgentsAssignedToMcpServer(s.id)).toEqual([]);
  });
});

describe('many-to-many assignment', () => {
  it('one server on many agents; one agent with many servers; idempotent assign', () => {
    seedAgentWithConfig();
    createAgentGroup({
      id: 'ag-2',
      name: 'two',
      folder: 'two',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    const a = createWebchatMcpServer({ name: 'a', transport: 'sse', url: 'http://a' });
    const b = createWebchatMcpServer({ name: 'b', transport: 'stdio', command: 'mcp-b' });
    assignMcpServerToAgent(GID, a.id);
    assignMcpServerToAgent(GID, a.id); // idempotent — ON CONFLICT DO NOTHING
    assignMcpServerToAgent(GID, b.id);
    assignMcpServerToAgent('ag-2', a.id);
    expect(getMcpServersForAgent(GID).map((s) => s.name)).toEqual(['a', 'b']);
    expect(getAgentsAssignedToMcpServer(a.id).sort()).toEqual(['ag-2', GID].sort());
    unassignMcpServerFromAgent(GID, a.id);
    expect(getMcpServersForAgent(GID).map((s) => s.name)).toEqual(['b']);
    expect(getAgentsAssignedToMcpServer(a.id)).toEqual(['ag-2']);
  });
});

describe('mcpServerToConfig', () => {
  it('stdio row → command/args/env config', () => {
    const s = createWebchatMcpServer({ name: 's', transport: 'stdio', command: 'c', args: ['--x'], env: { A: '1' } });
    expect(mcpServerToConfig(s)).toEqual({ command: 'c', args: ['--x'], env: { A: '1' } });
  });

  it('remote row → type/url/headers config, instructions carried', () => {
    const s = createWebchatMcpServer({
      name: 'r',
      transport: 'http',
      url: 'https://h/mcp',
      headers: { Authorization: 'Bearer t' },
      instructions: 'use sparingly',
    });
    expect(mcpServerToConfig(s)).toEqual({
      type: 'http',
      url: 'https://h/mcp',
      headers: { Authorization: 'Bearer t' },
      instructions: 'use sparingly',
    });
  });
});

describe('syncAgentMcpConfig — incremental single-key writes', () => {
  it('adds and removes only its own key, preserving ncl-added servers', () => {
    // Simulate a server added out-of-band via `ncl groups config add-mcp-server`.
    seedAgentWithConfig({ nclthing: { command: 'ncl-added', args: [], env: {} } });
    const s = createWebchatMcpServer({ name: 'windows', transport: 'sse', url: 'http://box:8000/sse' });

    expect(syncAgentMcpConfig(GID, s, true)).toBe(true);
    let servers = configServers();
    expect(Object.keys(servers).sort()).toEqual(['nclthing', 'windows']);
    expect(servers.windows).toEqual({ type: 'sse', url: 'http://box:8000/sse', headers: {} });

    expect(syncAgentMcpConfig(GID, s, false)).toBe(true);
    servers = configServers();
    expect(Object.keys(servers)).toEqual(['nclthing']); // the ncl-added key survived
  });

  it('returns false when the group has no container config row', () => {
    const s = createWebchatMcpServer({ name: 'w', transport: 'sse', url: 'http://x' });
    expect(syncAgentMcpConfig('no-such-group', s, true)).toBe(false);
  });
});
