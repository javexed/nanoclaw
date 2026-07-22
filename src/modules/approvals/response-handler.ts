/**
 * Handle an admin's response to an approval card.
 *
 * Two categories of pending_approvals rows exist:
 *   1. Module-initiated actions — the module called `requestApproval()` with
 *      some free-form `action` string and registered a handler via
 *      `registerApprovalHandler(action, handler)`. On approve, we look up the
 *      handler and call it; on plain reject we relay a decline to the agent; on
 *      "Reject with reason…" we hold the row and capture the admin's next DM as
 *      a one-line reason (see reason-capture.ts). Reject finalization is shared
 *      via finalizeReject.
 *   2. OneCLI credential approvals (`action = 'onecli_credential'`). Resolved
 *      via an in-memory Promise — see onecli-approvals.ts.
 *
 * The response handler is registered via core's `registerResponseHandler`;
 * core iterates handlers and the first one to return `true` claims the response.
 */
import { wakeContainer } from '../../container-runner.js';
import { deletePendingApproval, getPendingApproval, getSession } from '../../db/sessions.js';
import type { ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { PendingApproval } from '../../types.js';
import { hasAdminPrivilege, isGlobalAdmin, isOwner } from '../permissions/db/user-roles.js';
import { finalizeReject } from './finalize.js';
import { ONECLI_ACTION, resolveOneCLIApproval } from './onecli-approvals.js';
import { getApprovalHandler, notifyApprovalResolved, REJECT_WITH_REASON_VALUE } from './primitive.js';
import { armReasonCapture } from './reason-capture.js';

// Double-fire guard for the approve path. A slow handler (install_packages runs
// buildAgentGroupImage, ~30s) tempts an admin to click Approve again while
// nothing visibly happens, delivering the response twice; two concurrent
// rebuilds race on the same temp Dockerfile → "ENOENT unlink Dockerfile". We
// claim the approval IN-PROCESS — a synchronous check-and-add that completes
// before any `await`, so a concurrent second delivery is refused — and delete
// the pending_approvals ROW only AFTER the handler (releaseApproval).
//
// The row MUST stay live during the handler: an approved cli_command replays
// through dispatch() → guard(), whose grantSatisfies() re-checks the row via
// getPendingApproval() (src/guard/guard.ts). A destructive delete-up-front claim
// made that lookup return null, so every approval-gated command failed with
// "replay carried an invalid or mismatched grant". The host is a single process,
// so an in-process Set is a sufficient double-fire gate; a late repeat click
// after release finds no row (getPendingApproval at the top returns null).
const inFlightApprovals = new Set<string>();

function claimApproval(approvalId: string): boolean {
  if (inFlightApprovals.has(approvalId)) return false;
  inFlightApprovals.add(approvalId);
  return true;
}

/** Delete the resolved row and clear the in-flight claim — call AFTER the handler. */
function releaseApproval(approvalId: string): void {
  deletePendingApproval(approvalId);
  inFlightApprovals.delete(approvalId);
}

export async function handleApprovalsResponse(payload: ResponsePayload): Promise<boolean> {
  const approval = getPendingApproval(payload.questionId);
  if (!approval) return false;

  if (!isAuthorizedApprovalClick(approval, payload)) {
    log.warn('Ignoring unauthorized approval response', {
      approvalId: approval.approval_id,
      action: approval.action,
      userId: payload.userId,
      channelType: payload.channelType,
    });
    return true;
  }

  if (approval.action === ONECLI_ACTION) {
    if (resolveOneCLIApproval(payload.questionId, payload.value)) {
      return true;
    }
    // Row exists but the in-memory resolver is gone (timer fired or the process
    // was in a weird state). Nothing to do — just drop the row.
    deletePendingApproval(payload.questionId);
    return true;
  }

  await handleRegisteredApproval(approval, payload.value, namespacedUserId(payload) ?? '');
  return true;
}

async function handleRegisteredApproval(
  approval: PendingApproval,
  selectedOption: string,
  userId: string,
): Promise<void> {
  if (!approval.session_id) {
    deletePendingApproval(approval.approval_id);
    return;
  }
  const session = getSession(approval.session_id);
  if (!session) {
    deletePendingApproval(approval.approval_id);
    return;
  }

  // "Reject with reason…" — hold the row and capture the admin's next DM
  // instead of finalizing now. The agent is notified exactly once: after the
  // reason arrives, or after the sweep's timeout if the admin ghosts.
  if (selectedOption === REJECT_WITH_REASON_VALUE) {
    await armReasonCapture(approval, session, userId);
    return;
  }

  // Plain Reject (or any other non-approve value) — instant fast path.
  if (selectedOption !== 'approve') {
    await finalizeReject(approval, session, userId);
    return;
  }

  // Approved — dispatch to the module that registered for this action.
  //
  // Claim in-process first (double-click / concurrent-delivery guard). The row
  // itself is deleted AFTER the handler (releaseApproval) so the approved
  // replay's guard liveness check still sees it — see the claimApproval note.
  if (!claimApproval(approval.approval_id)) return;

  const notify = (text: string): void => {
    writeSessionMessage(session.agent_group_id, session.id, {
      id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
    });
  };

  const handler = getApprovalHandler(approval.action);
  if (!handler) {
    log.warn('No approval handler registered — row dropped', {
      approvalId: approval.approval_id,
      action: approval.action,
    });
    notify(`Your ${approval.action} was approved, but no handler is installed to apply it.`);
    releaseApproval(approval.approval_id);
    await notifyApprovalResolved({ approval, session, outcome: 'approve', userId });
    await wakeContainer(session);
    return;
  }

  const payload = JSON.parse(approval.payload);
  try {
    await handler({ session, payload, approval, userId, notify });
    log.info('Approval handled', { approvalId: approval.approval_id, action: approval.action, userId });
  } catch (err) {
    log.error('Approval handler threw', { approvalId: approval.approval_id, action: approval.action, err });
    notify(
      `Your ${approval.action} was approved, but applying it failed: ${err instanceof Error ? err.message : String(err)}.`,
    );
  } finally {
    // Delete AFTER the handler so the approved replay's guard liveness check
    // (getPendingApproval) saw the row while it ran — see the claimApproval note.
    releaseApproval(approval.approval_id);
  }

  await notifyApprovalResolved({ approval, session, outcome: 'approve', userId });
  await wakeContainer(session);
}

/**
 * Fork (approval pre-judge): resolve a pending approval through the exact
 * same dispatch path a human Approve click takes — in-process claim, handler
 * dispatch, agent notify, resolved-callbacks, container wake. `userId`
 * records the resolver for audit surfaces (e.g. `prejudge:<model-id>`).
 */
export async function resolveApprovalAsApproved(approval: PendingApproval, userId: string): Promise<void> {
  await handleRegisteredApproval(approval, 'approve', userId);
}

function namespacedUserId(payload: ResponsePayload): string | null {
  if (!payload.userId) return null;
  return payload.userId.includes(':') ? payload.userId : `${payload.channelType}:${payload.userId}`;
}

function isAuthorizedApprovalClick(approval: PendingApproval, payload: ResponsePayload): boolean {
  const userId = namespacedUserId(payload);
  if (!userId) return false;

  // An approval may name a specific approver; only that exact user may resolve it.
  if (approval.approver_user_id) {
    return userId === approval.approver_user_id;
  }

  const agentGroupId =
    approval.agent_group_id ?? (approval.session_id ? getSession(approval.session_id)?.agent_group_id : null);

  if (!agentGroupId) {
    return isOwner(userId) || isGlobalAdmin(userId);
  }

  return hasAdminPrivilege(userId, agentGroupId);
}
