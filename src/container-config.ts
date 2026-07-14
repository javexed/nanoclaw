/**
 * Container config types and materialization.
 *
 * Source of truth is the `container_configs` table in the central DB.
 * This module provides:
 *   - Type definitions for the file shape (read by the container runner)
 *   - `materializeContainerJson()` — writes `groups/<folder>/container.json`
 *     from the DB at spawn time
 *   - `configFromDb()` — builds a `ContainerConfig` from a DB row + agent group
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { resolveContainerConfigAugmentation } from './container-runtime.js';
import { getContainerConfig } from './db/container-configs.js';
import { getAgentGroup } from './db/agent-groups.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

/**
 * An MCP server wired into an agent group. Two transports:
 *  - stdio (default): a subprocess spawned inside the container (`command`).
 *  - remote (sse | http): a server reached over the network by `url` — e.g. a
 *    tool server running on another machine. Both pass through container.json
 *    verbatim into the Agent SDK's `mcpServers`, which accepts the same union.
 * `instructions` (either transport) is materialized as an inline CLAUDE.md
 * fragment for the server (see claude-md-compose.ts).
 */
export type McpServerConfig = McpStdioServerConfig | McpRemoteServerConfig;

export interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  instructions?: string;
  /** Tool allowlist — absent means every tool the server exposes. */
  enabledTools?: string[];
}

export interface McpRemoteServerConfig {
  type: 'sse' | 'http';
  url: string;
  headers?: Record<string, string>;
  instructions?: string;
  /** Tool allowlist — absent means every tool the server exposes. */
  enabledTools?: string[];
}

export interface AdditionalMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

/** Shape of the materialized `container.json` file read by the container runner. */
export interface ContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  skills: string[] | 'all';
  provider?: string;
  groupName?: string;
  assistantName?: string;
  agentGroupId?: string;
  maxMessagesPerPrompt?: number;
  model?: string;
  effort?: string;
  /**
   * Deliver unwrapped agent prose to the originating room instead of dropping
   * it as scratchpad. Contributed by an installed module (webchat sets it for
   * ollama-backed groups, whose small models rarely emit the <message> envelope)
   * via resolveContainerConfigAugmentation. Read by the agent-runner.
   */
  lenientOutput?: boolean;
  /**
   * Learning-loop behavior (docs/learning-loop.md). Absent keys mean defaults:
   * autoTrigger ON (a busy turn auto-runs the review; it only STAGES a draft),
   * autoKeep OFF (auto-accepting self-written context is an owner-level opt-in),
   * cooldownMinutes 30.
   */
  learning?: { autoTrigger?: boolean; autoKeep?: boolean; cooldownMinutes?: number };
}

/** Build a `ContainerConfig` from a DB row + agent group identity. */
export function configFromDb(row: ContainerConfigRow, group: AgentGroup): ContainerConfig {
  return {
    mcpServers: JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>,
    packages: {
      apt: JSON.parse(row.packages_apt) as string[],
      npm: JSON.parse(row.packages_npm) as string[],
    },
    imageTag: row.image_tag ?? undefined,
    additionalMounts: JSON.parse(row.additional_mounts) as AdditionalMountConfig[],
    skills: JSON.parse(row.skills) as string[] | 'all',
    provider: row.provider ?? undefined,
    groupName: group.name,
    assistantName: row.assistant_name ?? group.name,
    agentGroupId: group.id,
    maxMessagesPerPrompt: row.max_messages_per_prompt ?? undefined,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    learning: parseLearning(row.learning),
  };
}

function parseLearning(raw: string | null | undefined): ContainerConfig['learning'] {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    return v && typeof v === 'object' && Object.keys(v).length > 0 ? (v as ContainerConfig['learning']) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Materialize `container.json` from the DB. Called at spawn time so the
 * container always sees fresh config. Returns the `ContainerConfig` for
 * use by the caller (buildMounts, buildContainerArgs, etc.).
 */
export function materializeContainerJson(agentGroupId: string): ContainerConfig {
  const group = getAgentGroup(agentGroupId);
  if (!group) throw new Error(`Agent group not found: ${agentGroupId}`);

  const row = getContainerConfig(agentGroupId);
  if (!row) throw new Error(`Container config not found for agent group: ${agentGroupId}`);

  // Merge module-contributed fields (e.g. webchat's lenientOutput for ollama
  // groups). Augmentors only add keys not owned by the DB row, so a stray key
  // can't clobber core config; spread last so an explicit contribution wins.
  const config = { ...configFromDb(row, group), ...resolveContainerConfigAugmentation(agentGroupId) };

  const p = path.join(GROUPS_DIR, group.folder, 'container.json');
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');

  return config;
}
