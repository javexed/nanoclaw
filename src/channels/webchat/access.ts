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
import { hasAdminPrivilege, isGlobalAdmin, isOwner } from './roles.js';

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

/**
 * Authorize the global-archive / unarchive operation on a room. Wider than
 * just access (any member can SEE a room) but narrower than full owner-only
 * — scoped admins of any agent wired to the room can archive too. Owner +
 * global admin always pass.
 */
export function canArchiveRoom(userId: string, roomId: string): boolean {
  if (isOwner(userId) || isGlobalAdmin(userId)) return true;
  const agents = getAgentsForWebchatRoom(roomId);
  for (const a of agents) {
    if (hasAdminPrivilege(userId, a.id)) return true;
  }
  return false;
}
