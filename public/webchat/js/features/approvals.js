// ── Approvals (M3) ───────────────────────────────────────────────────────────
// M2 stub: in-chat approval cards and the owner inbox land in M3 with the
// trunk-side listener plumbing. Until then an `approval` push surfaces as a
// toast so nothing arrives silently.
import { showToast } from '../core/toast.js';
export function handleApprovalEvent(msg) {
    showToast(`Approval requested: ${msg.title ?? 'an agent action'} — handle it via ncl for now`, {
        kind: 'info',
        timeout: 10_000,
    });
}
export function handleApprovalResolved(_msg) {
    /* card UI arrives in M3 */
}
