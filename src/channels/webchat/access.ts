/**
 * Per-room access control.
 *
 * Webchat rooms are messaging_groups rows wired to one or more agent groups
 * via messaging_group_agents. A user has access to a room if they have
 * access to *any* of the agents wired to it. Agent-group access is
 * delegated to the cross-channel permissions module so the policy stays
 * consistent with command-gate, approvals, etc.
 */
import { canAccessAgentGroup } from '../../modules/permissions/access.js';
import { getAgentsForWebchatRoom } from './db.js';
import type { WebchatRoom } from './db.js';

export function canAccessRoom(userId: string, roomId: string): boolean {
  const agents = getAgentsForWebchatRoom(roomId);
  if (agents.length === 0) return false;
  for (const a of agents) {
    if (canAccessAgentGroup(userId, a.id).allowed) return true;
  }
  return false;
}

export function filterRoomsForUser<T extends WebchatRoom>(userId: string, rooms: T[]): T[] {
  return rooms.filter((r) => canAccessRoom(userId, r.id));
}
