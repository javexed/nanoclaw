// Module seams around approval creation: intercepts that may fully resolve a
// hold before it is delivered, and listeners that mirror an actionable card
// wherever an installed surface wants it.
import { log } from '../log.js';
import type { RawOption } from '../channels/ask-question.js';
import type { Session } from '../types.js';

export interface ApprovalRequestedEvent {
  approvalId: string;
  session: Session;
  action: string;
  title: string;
  question: string;
  options: RawOption[];
  approvers: string[];
  agentName?: string;
}
export type ApprovalRequestedListener = (e: ApprovalRequestedEvent) => void;
const approvalRequestedListeners: ApprovalRequestedListener[] = [];
export function registerApprovalRequestedListener(cb: ApprovalRequestedListener): void {
  approvalRequestedListeners.push(cb);
}
/**
 * Fired when an approval is created (after any intercept declines to resolve
 * it), in addition to the approver delivery. Best-effort: exceptions are
 * logged and swallowed.
 */
export function notifyApprovalRequested(e: ApprovalRequestedEvent): void {
  for (const cb of approvalRequestedListeners) {
    try {
      cb(e);
    } catch (err) {
      log.error('approvalRequested listener threw', { approvalId: e.approvalId, err });
    }
  }
}

export type ApprovalIntercept = (approvalId: string, session: Session, question?: string) => Promise<boolean>;
const approvalIntercepts: ApprovalIntercept[] = [];
export function registerApprovalIntercept(fn: ApprovalIntercept): void {
  approvalIntercepts.push(fn);
}
/** True when an intercept fully resolved the hold; anything else falls through to delivery. */
export async function runApprovalIntercepts(approvalId: string, session: Session, question?: string): Promise<boolean> {
  for (const fn of approvalIntercepts) {
    try {
      if (await fn(approvalId, session, question)) return true;
    } catch (err) {
      log.error('Approval intercept threw — falling through to delivery', { approvalId, err });
    }
  }
  return false;
}
