/**
 * Guarded handler bodies for self-modification actions.
 *
 * The delivery registry's guard wrapper runs these only on `allow` — which,
 * for self-mod, means an approved replay carrying a valid grant (the
 * decision holds unconditionally from the container path; see ./guard.ts).
 * Each body mutates the container config in the DB, rebuilds/kills the
 * container as needed, and writes an on_wake message so the fresh container
 * picks up where the old one left off.
 *
 * install_packages: update DB + rebuild image + kill container + on_wake.
 * add_mcp_server: update DB + kill container + on_wake.
 */
import { buildAgentGroupImage, killContainer, wakeContainer } from '../../container-runner.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { getSession, getSessionsByAgentGroup } from '../../db/sessions.js';
import type { McpServerConfig } from '../../container-config.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';

/**
 * A config/image change applies to the whole agent group, but only the session
 * that requested it gets its container killed+respawned above. Any OTHER active
 * session of the same group (an agent wired to multiple rooms has one session
 * per room) keeps running its stale container — the old image without the new
 * package, or the old container.json without the new MCP server — so the agent
 * in that room never sees the change and re-requests it forever.
 *
 * Kill those sibling containers too. They carry no on_wake note (they didn't
 * request anything) and aren't force-woken — each respawns on the current
 * image/config on its next message.
 */
function respawnSiblingSessions(agentGroupId: string, requestingSessionId: string, reason: string): void {
  for (const s of getSessionsByAgentGroup(agentGroupId)) {
    if (s.id === requestingSessionId || s.status !== 'active') continue;
    killContainer(s.id, reason);
  }
}

function newApprNoteId(): string {
  return `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Common tail after a config/image change is applied: hand the requesting
 * session an on_wake note (picked up on the fresh container's first poll, so a
 * dying container can't steal it), respawn that container, and respawn every
 * stale sibling session. `onWakeText` is the verify-and-report instruction the
 * agent reads after respawn.
 */
function notifyAndRespawn(session: Session, onWakeText: string, reason: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: newApprNoteId(),
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text: onWakeText, sender: 'system', senderId: 'system' }),
    onWake: 1,
  });
  killContainer(session.id, reason, () => {
    const s = getSession(session.id);
    if (s) wakeContainer(s);
  });
  respawnSiblingSessions(session.agent_group_id, session.id, `sibling session stale after ${reason}`);
}

export async function applyInstallPackages(payload: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'install_packages approved but agent group missing.');
    return;
  }

  const configRow = getContainerConfig(agentGroup.id);
  if (!configRow) {
    notifyAgent(session, 'install_packages approved but container config missing.');
    return;
  }

  // Append new packages to existing lists in the DB (deduplicated)
  if (payload.apt) {
    const existing = JSON.parse(configRow.packages_apt) as string[];
    for (const pkg of payload.apt as string[]) {
      if (!existing.includes(pkg)) existing.push(pkg);
    }
    updateContainerConfigJson(agentGroup.id, 'packages_apt', existing);
  }
  if (payload.npm) {
    const existing = JSON.parse(configRow.packages_npm) as string[];
    for (const pkg of payload.npm as string[]) {
      if (!existing.includes(pkg)) existing.push(pkg);
    }
    updateContainerConfigJson(agentGroup.id, 'packages_npm', existing);
  }

  const pkgs = [
    ...((payload.apt as string[] | undefined) || []),
    ...((payload.npm as string[] | undefined) || []),
  ].join(', ');
  log.info('Package install approved', { agentGroupId: session.agent_group_id });
  try {
    await buildAgentGroupImage(session.agent_group_id);
    notifyAndRespawn(
      session,
      `Packages installed (${pkgs}) and container rebuilt. Verify the new packages are available (e.g. run them or check versions) and report the result to the user.`,
      'rebuild applied',
    );
    log.info('Container rebuild completed (bundled with install)', { agentGroupId: session.agent_group_id });
  } catch (e) {
    notifyAgent(
      session,
      `Packages added to config (${pkgs}) but rebuild failed: ${e instanceof Error ? e.message : String(e)}. Tell the user — an admin will need to retry the install_packages request or inspect the build logs.`,
    );
    log.error('Bundled rebuild failed after install approval', { agentGroupId: session.agent_group_id, err: e });
  }
}

export async function applyAddMcpServer(payload: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'add_mcp_server approved but agent group missing.');
    return;
  }

  const configRow = getContainerConfig(agentGroup.id);
  if (!configRow) {
    notifyAgent(session, 'add_mcp_server approved but container config missing.');
    return;
  }

  // Add the new MCP server to the existing map in the DB
  const servers = JSON.parse(configRow.mcp_servers) as Record<string, McpServerConfig>;
  servers[payload.name as string] = {
    command: payload.command as string,
    args: (payload.args as string[]) || [],
    env: (payload.env as Record<string, string>) || {},
  };
  updateContainerConfigJson(agentGroup.id, 'mcp_servers', servers);

  notifyAndRespawn(
    session,
    `MCP server "${payload.name}" added. Verify it's available (e.g. list your tools) and report the result to the user.`,
    'mcp server added',
  );
  log.info('MCP server add approved', { agentGroupId: session.agent_group_id });
}
