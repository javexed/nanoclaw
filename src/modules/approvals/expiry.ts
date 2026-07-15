/**
 * Approval TTL — a pending approval that nobody answers eventually DENIES
 * itself (default 24h, NANOCLAW_APPROVAL_TTL_HOURS overrides, 0 disables).
 *
 * Why deny and not linger: a stale approval is its own hazard — the request
 * that finally gets tapped three days later executes in a context nobody
 * remembers. Expiry goes through the SAME finalizeReject path a human deny
 * uses, so the agent gets told, the cards flip everywhere, and the container
 * wakes to see the outcome. (Chat approvals are asynchronous by nature, so
 * the window is hours, not an interactive CLI's 60 seconds.)
 */
import { getExpiredPendingApprovals, getSession } from '../../db/sessions.js';
import { finalizeReject } from './finalize.js';
import { log } from '../../log.js';

const DEFAULT_TTL_HOURS = 24;

export function approvalTtlMs(): number {
  const raw = process.env.NANOCLAW_APPROVAL_TTL_HOURS;
  const hours = raw === undefined || raw === '' ? DEFAULT_TTL_HOURS : Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) return 0; // 0/invalid = disabled
  return hours * 60 * 60 * 1000;
}

/** Deny every pending approval older than the TTL. Returns how many expired. */
export async function sweepExpiredApprovals(now = Date.now()): Promise<number> {
  const ttl = approvalTtlMs();
  if (ttl === 0) return 0;
  const expired = getExpiredPendingApprovals(now - ttl);
  for (const approval of expired) {
    try {
      const session = approval.session_id ? getSession(approval.session_id) : undefined;
      if (!session) continue;
      await finalizeReject(
        approval,
        session,
        'system:expiry',
        `no response within ${Math.round(ttl / 3_600_000)}h — expired`,
      );
      log.info('Approval expired (auto-denied)', {
        approvalId: approval.approval_id,
        action: approval.action,
        ageHours: Math.round((now - Date.parse(approval.created_at)) / 3_600_000),
      });
    } catch (err) {
      log.warn('Approval expiry sweep: finalize failed', { approvalId: approval.approval_id, err: String(err) });
    }
  }
  return expired.length;
}
