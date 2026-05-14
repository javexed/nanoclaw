/**
 * `create_agent` delivery-action handler.
 *
 * Spawns a new agent group on demand from the parent agent, wires bidirectional
 * agent_destinations rows, projects the new destination into the parent's
 * running container, and notifies the parent.
 */
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { AgentGroup, Session } from '../../types.js';
import { createDestination, getDestinationByName, normalizeName } from './db/agent-destinations.js';
import { writeDestinations } from './write-destinations.js';

// webchat:create-agent-gating START — installed by /add-webchat
// Restored by unpatch-create-agent.mjs when /remove-webchat runs.
import Database from 'better-sqlite3';
import { inboundDbPath } from '../../session-manager.js';
import { hasAdminPrivilege, isOwner } from '../permissions/db/user-roles.js';

export interface CreateAgentAuthChecks {
  isOwner(userId: string): boolean;
  isAdminOf(userId: string, agentGroupId: string): boolean;
}

export type CreateAgentAuthDecision =
  | { allowed: true; reason: 'cli' | 'owner' | 'admin_of_group' }
  | { allowed: false; reason: 'no_trigger' | 'unauthorized' };

/**
 * Pure authorization decision so it can be unit-tested without DB setup.
 *
 * The `cli:` carve-out exists because the CLI channel reaches us through
 * a local Unix socket — filesystem permissions already gate access, so
 * anyone who can write to the socket has a shell on this host.
 */
export function decideCreateAgentAuthorization(
  senderId: string | null,
  agentGroupId: string,
  checks: CreateAgentAuthChecks,
): CreateAgentAuthDecision {
  if (!senderId) return { allowed: false, reason: 'no_trigger' };
  if (senderId.startsWith('cli:')) return { allowed: true, reason: 'cli' };
  if (checks.isOwner(senderId)) return { allowed: true, reason: 'owner' };
  if (checks.isAdminOf(senderId, agentGroupId)) return { allowed: true, reason: 'admin_of_group' };
  return { allowed: false, reason: 'unauthorized' };
}

/**
 * Read the senderId of the most recent chat-kind inbound message for this
 * session from the host-owned inbound.db. The container can write whatever
 * it wants to outbound.db, so we cannot trust a triggeredBy claim coming
 * back through the action payload — we re-derive it from trusted state.
 */
function findTriggerSenderId(session: import('../../types.js').Session): string | null {
  const dbPath = inboundDbPath(session.agent_group_id, session.id);
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
  try {
    const row = db
      .prepare(
        `SELECT content FROM messages_in
         WHERE kind = 'chat'
         ORDER BY seq DESC
         LIMIT 1`,
      )
      .get() as { content: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.content) as { senderId?: unknown };
      return typeof parsed.senderId === 'string' ? parsed.senderId : null;
    } catch {
      return null;
    }
  } finally {
    db.close();
  }
}
// webchat:create-agent-gating END

function notifyAgent(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) => log.error('Failed to wake container after notification', { err }));
  }
}

export async function handleCreateAgent(content: Record<string, unknown>, session: Session): Promise<void> {
  const requestId = content.requestId as string;
  const name = content.name as string;
  const instructions = content.instructions as string | null;

  const sourceGroup = getAgentGroup(session.agent_group_id);
  if (!sourceGroup) {
    notifyAgent(session, `create_agent failed: source agent group not found.`);
    log.warn('create_agent failed: missing source group', { sessionAgentGroup: session.agent_group_id, name });
    return;
  }

  // webchat:create-agent-gating-call START — installed by /add-webchat
  const _triggerSender = findTriggerSenderId(session);
  const _decision = decideCreateAgentAuthorization(_triggerSender, sourceGroup.id, {
    isOwner,
    isAdminOf: hasAdminPrivilege,
  });
  if (!_decision.allowed) {
    const _reason =
      _decision.reason === 'no_trigger'
        ? 'no identifiable user trigger for this turn'
        : 'requesting user lacks owner/admin privilege';
    notifyAgent(session, `create_agent denied: ${_reason}.`);
    log.warn('create_agent denied', {
      reason: _decision.reason,
      sender: _triggerSender,
      source: sourceGroup.id,
      name,
    });
    return;
  }
  // webchat:create-agent-gating-call END

  const localName = normalizeName(name);

  // Collision in the creator's destination namespace
  if (getDestinationByName(sourceGroup.id, localName)) {
    notifyAgent(session, `Cannot create agent "${name}": you already have a destination named "${localName}".`);
    return;
  }

  // Derive a safe folder name, deduplicated globally across agent_groups.folder
  let folder = localName;
  let suffix = 2;
  while (getAgentGroupByFolder(folder)) {
    folder = `${localName}-${suffix}`;
    suffix++;
  }

  const groupPath = path.join(GROUPS_DIR, folder);
  const resolvedPath = path.resolve(groupPath);
  const resolvedGroupsDir = path.resolve(GROUPS_DIR);
  if (!resolvedPath.startsWith(resolvedGroupsDir + path.sep)) {
    notifyAgent(session, `Cannot create agent "${name}": invalid folder path.`);
    log.error('create_agent path traversal attempt', { folder, resolvedPath });
    return;
  }

  const agentGroupId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  const newGroup: AgentGroup = {
    id: agentGroupId,
    name,
    folder,
    agent_provider: null,
    created_at: now,
  };
  createAgentGroup(newGroup);
  initGroupFilesystem(newGroup, { instructions: instructions ?? undefined });

  // Insert bidirectional destination rows (= ACL grants).
  // Creator refers to child by the name it chose; child refers to creator as "parent".
  createDestination({
    agent_group_id: sourceGroup.id,
    local_name: localName,
    target_type: 'agent',
    target_id: agentGroupId,
    created_at: now,
  });
  // Handle the unlikely case where the child already has a "parent" destination
  // (shouldn't happen for a brand-new agent, but be safe).
  let parentName = 'parent';
  let parentSuffix = 2;
  while (getDestinationByName(agentGroupId, parentName)) {
    parentName = `parent-${parentSuffix}`;
    parentSuffix++;
  }
  createDestination({
    agent_group_id: agentGroupId,
    local_name: parentName,
    target_type: 'agent',
    target_id: sourceGroup.id,
    created_at: now,
  });

  // REQUIRED: project the new destination into the running container's
  // inbound.db. See the top-of-file invariant in db/agent-destinations.ts
  // — forgetting this causes "dropped: unknown destination" when the parent
  // tries to send to the newly-created child.
  writeDestinations(session.agent_group_id, session.id);

  // Fire-and-forget notification back to the creator
  notifyAgent(
    session,
    `Agent "${localName}" created. You can now message it with <message to="${localName}">...</message>.`,
  );
  log.info('Agent group created', { agentGroupId, name, localName, folder, parent: sourceGroup.id });
  // Note: requestId is unused — this is fire-and-forget, not request/response.
  void requestId;
}
