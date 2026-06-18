/**
 * Session teardown primitives.
 *
 * Anything that deletes a row referenced by `sessions` (e.g. a
 * `messaging_groups` row, an `agent_groups` row) must first tear down the
 * matching sessions, or SQLite will reject the parent delete with
 * "FOREIGN KEY constraint failed". Teardown has two phases:
 *
 *   1. DB phase (`deleteSessionDbState`) — runs INSIDE the caller's
 *      transaction. Drops `pending_questions` + `pending_approvals` rows
 *      that FK to the session, then the `sessions` row itself.
 *
 *   2. Resource phase (`teardownSessionResources`) — runs AFTER commit.
 *      Kills the container process and removes the session directory on
 *      disk. Side-effects can't roll back, so they live outside the tx.
 *
 * Callers use `findSessionsByMessagingGroup` / `findSessionsByAgentGroup`
 * to snapshot the targets before the transaction begins, then call the
 * two phases above.
 */
import fs from 'fs';

import { getDb, hasTable } from './db/connection.js';
import { log } from './log.js';
import { sessionDir } from './session-manager.js';

export interface TeardownTarget {
  sessionId: string;
  agentGroupId: string;
}

function findSessionsBy(column: 'messaging_group_id' | 'agent_group_id', value: string): TeardownTarget[] {
  const rows = getDb().prepare(`SELECT id, agent_group_id FROM sessions WHERE ${column} = ?`).all(value) as {
    id: string;
    agent_group_id: string;
  }[];
  return rows.map((r) => ({ sessionId: r.id, agentGroupId: r.agent_group_id }));
}

export function findSessionsByMessagingGroup(messagingGroupId: string): TeardownTarget[] {
  return findSessionsBy('messaging_group_id', messagingGroupId);
}

export function findSessionsByAgentGroup(agentGroupId: string): TeardownTarget[] {
  return findSessionsBy('agent_group_id', agentGroupId);
}

/**
 * Delete DB rows that FK to this session, then the session row itself.
 * Call inside a `db.transaction()` so a failure rolls back cleanly. Does
 * NOT touch the container or the session dir — those are side-effects and
 * belong to `teardownSessionResources` after commit.
 */
export function deleteSessionDbState(sessionId: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM pending_questions WHERE session_id = ?`).run(sessionId);
  if (hasTable(db, 'pending_approvals')) {
    db.prepare(`DELETE FROM pending_approvals WHERE session_id = ?`).run(sessionId);
  }
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
}

/**
 * Best-effort post-commit cleanup: kill running containers and remove
 * session directories on disk. Logs and continues on failure — at this
 * point the DB is the source of truth and any orphan dir is recoverable
 * by the host sweep.
 */
export async function teardownSessionResources(targets: TeardownTarget[], reason: string): Promise<void> {
  if (targets.length === 0) return;
  // Lazy-import container-runner so unit tests that only exercise the DB
  // primitives don't drag in the OneCLI SDK / container runtime modules.
  const { killContainer } = await import('./container-runner.js');
  const { stopSessionStatus } = await import('./modules/agent-status/index.js');
  for (const t of targets) {
    killContainer(t.sessionId, reason);
    stopSessionStatus(t.sessionId);
    const dir = sessionDir(t.agentGroupId, t.sessionId);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      log.warn('Session teardown: failed to remove session dir', { sessionId: t.sessionId, err });
    }
  }
}
