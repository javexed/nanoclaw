/**
 * Shared builder/validator for a single MCP server entry.
 *
 * One code path so the two front doors agree on what a valid server looks
 * like: the `ncl groups config add-mcp-server` command (src/cli/resources/
 * groups.ts) and the webchat per-agent MCP UI route (src/channels/webchat/
 * server.ts). Both persist the result into `container_configs.mcp_servers`.
 */
import type { McpServerConfig } from './container-config.js';

/** Parsed inputs (callers JSON-parse args/env/headers before calling). */
export interface McpServerInput {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string; // 'sse' | 'http'
  headers?: Record<string, string>;
  instructions?: string;
}

/** MCP server names become tool prefixes (`mcp__<name>__*`) — keep them tame. */
export function validateMcpServerName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) throw new Error('name is required');
  const n = name.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(n)) {
    throw new Error('name must contain only letters, numbers, dashes or underscores');
  }
  return n;
}

/**
 * Build a validated `McpServerConfig` from raw input. Discriminates on which of
 * `url` (remote) / `command` (stdio) is present — exactly one is required.
 * Throws with a user-facing message on any invalid combination.
 */
export function buildMcpServerConfig(input: McpServerInput): McpServerConfig {
  const url = input.url?.trim();
  const command = input.command?.trim();
  if (url && command) throw new Error('provide either a remote url or a stdio command, not both');
  if (!url && !command) throw new Error('a remote url or a stdio command is required');

  if (url) {
    const type = input.type?.trim() || 'sse';
    if (type !== 'sse' && type !== 'http') throw new Error('type must be sse or http');
    const cfg: McpServerConfig = { type, url, headers: input.headers ?? {} };
    if (input.instructions?.trim()) cfg.instructions = input.instructions.trim();
    return cfg;
  }

  const cfg: McpServerConfig = { command: command as string, args: input.args ?? [], env: input.env ?? {} };
  if (input.instructions?.trim()) cfg.instructions = input.instructions.trim();
  return cfg;
}
