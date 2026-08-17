/**
 * Host-sweep pruner for cross-session echo backlogs.
 *
 * Pending trigger=0 rows have no other TTL — without this, fan-out grows
 * inbound.db unboundedly. Runs inside the
 * per-session sweep with the session's already-open inbound.db (host-owned,
 * host is the sole writer). Only 'pending' echo rows are touched: delivered
 * context (status completed) is the container's history, not backlog.
 */
import type Database from 'better-sqlite3';

import { ECHO_BACKLOG_CAP, ECHO_CHANNEL_TYPE, ECHO_MAX_AGE_DAYS } from './config.js';

/**
 * Prune pending 'session-echo' rows in one session's inbound.db:
 *   1. drop rows older than ECHO_MAX_AGE_DAYS,
 *   2. keep only the newest ECHO_BACKLOG_CAP by seq.
 * Returns the number of rows deleted.
 */
export function pruneEchoBacklog(db: Database.Database, opts: { now?: number } = {}): number {
  const keep = ECHO_BACKLOG_CAP;
  const cutoffIso = new Date((opts.now ?? Date.now()) - ECHO_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const expired = db
    .prepare(
      `DELETE FROM messages_in
        WHERE channel_type = ? AND status = 'pending'
          AND datetime(timestamp) < datetime(?)`,
    )
    .run(ECHO_CHANNEL_TYPE, cutoffIso).changes;

  const overflow = db
    .prepare(
      `DELETE FROM messages_in
        WHERE channel_type = ? AND status = 'pending'
          AND seq NOT IN (
            SELECT seq FROM messages_in
             WHERE channel_type = ? AND status = 'pending'
             ORDER BY seq DESC LIMIT ?
          )`,
    )
    .run(ECHO_CHANNEL_TYPE, ECHO_CHANNEL_TYPE, keep).changes;

  return expired + overflow;
}
