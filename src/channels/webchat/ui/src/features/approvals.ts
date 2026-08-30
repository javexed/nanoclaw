// ── Approvals ────────────────────────────────────────────────────────────────
// Two surfaces, one respond path:
//   - In-room cards: the server stores an approval message in the transcript;
//     transcript.ts calls buildApprovalCard to render it actionable. The
//     `approval_resolved` broadcast flips it live.
//   - The inbox: approvals whose agent has no webchat room reach the owner as
//     a WS `approval` push (plus /api/approvals/pending on connect) — shown
//     as a persistent toast with the same buttons.
// Both call POST /api/approvals/:id/respond, which routes through the exact
// dispatch a platform button-click takes (claim guard included).
import { apiJson } from '../core/api.js';
import { showToast, toastError } from '../core/toast.js';

interface ApprovalOption {
  label: string;
  value: string;
}

async function respond(questionId: string, value: string): Promise<void> {
  await apiJson(`/api/approvals/${encodeURIComponent(questionId)}/respond`, { method: 'POST', body: { value } });
}

function optionButtons(questionId: string, options: ApprovalOption[], onDone: () => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'appr-actions';
  const list =
    options.length > 0
      ? options
      : [
          { label: 'Approve', value: 'approve' },
          { label: 'Reject', value: 'reject' },
        ];
  for (const opt of list) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'appr-btn' + (opt.value === 'approve' ? ' appr-approve' : '');
    btn.textContent = opt.label;
    btn.addEventListener('click', async (e) => {
      // Don't let the click bubble to the toast's click-to-dismiss — that would
      // tear the card down mid-POST, and the error path would re-enable buttons
      // no longer in the DOM.
      e.stopPropagation();
      // Disable immediately — the server's claim guard makes a double-click
      // harmless, but a frozen row reads better than two spinners.
      row.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
      try {
        await respond(questionId, opt.value);
        onDone();
      } catch (err) {
        row.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = false));
        toastError(err, 'Could not resolve the approval');
      }
    });
    row.appendChild(btn);
  }
  return row;
}

/** Render one in-room approval card (called from transcript.ts's buildRow). */
export function buildApprovalCard(msg: { content?: string; message_type?: string }): HTMLElement {
  let data: {
    questionId?: string;
    title?: string;
    question?: string;
    options?: ApprovalOption[];
    resolvedBy?: string;
  } = {};
  try {
    data = JSON.parse(msg.content ?? '{}');
  } catch {
    /* render as unparsed */
  }
  const resolved = msg.message_type === 'approval_resolved' || !!data.resolvedBy;

  const card = document.createElement('div');
  card.className = 'appr-card' + (resolved ? ' appr-resolved' : '');
  card.dataset.approvalId = data.questionId ?? '';

  const title = document.createElement('div');
  title.className = 'appr-title';
  title.textContent = `🔒 ${data.title || 'Approval requested'}`;
  card.appendChild(title);

  if (data.question) {
    const q = document.createElement('div');
    q.className = 'appr-question';
    q.textContent = data.question;
    card.appendChild(q);
  }

  if (resolved) {
    const note = document.createElement('div');
    note.className = 'appr-note';
    const who = data.resolvedBy ? String(data.resolvedBy).split(':').pop() : null;
    note.textContent = who ? `Resolved by ${who}` : 'Resolved';
    card.appendChild(note);
  } else if (data.questionId) {
    card.appendChild(
      optionButtons(data.questionId, data.options ?? [], () => {
        // The approval_resolved broadcast rewrites the card; this is just the
        // instant local feedback.
        card.classList.add('appr-resolved');
        card.querySelector('.appr-actions')?.remove();
        const note = document.createElement('div');
        note.className = 'appr-note';
        note.textContent = 'Resolved';
        card.appendChild(note);
      }),
    );
  }
  return card;
}

/** Flip an in-room card when another surface resolved it. */
export function handleApprovalResolved(msg: { approvalId?: string; resolvedBy?: string }): void {
  if (!msg.approvalId) return;
  const card = document.querySelector(`.appr-card[data-approval-id="${CSS.escape(msg.approvalId)}"]`);
  if (!card) {
    dismissInboxToast(msg.approvalId);
    return;
  }
  card.classList.add('appr-resolved');
  card.querySelector('.appr-actions')?.remove();
  if (!card.querySelector('.appr-note')) {
    const note = document.createElement('div');
    note.className = 'appr-note';
    const who = msg.resolvedBy ? String(msg.resolvedBy).split(':').pop() : null;
    note.textContent = who ? `Resolved by ${who}` : 'Resolved';
    card.appendChild(note);
  }
  dismissInboxToast(msg.approvalId);
}

// ── Inbox surface (agents without a webchat room) ────────────────────────────

const inboxToasts = new Map<string, HTMLElement>();

function dismissInboxToast(questionId: string): void {
  inboxToasts.get(questionId)?.remove();
  inboxToasts.delete(questionId);
}

function showInboxApproval(payload: {
  questionId?: string;
  title?: string;
  question?: string;
  options?: ApprovalOption[];
}): void {
  const questionId = payload.questionId;
  if (!questionId || inboxToasts.has(questionId)) return;
  const toast = showToast(`🔒 ${payload.title || 'Approval requested'}`, { kind: 'info', timeout: 24 * 3600 * 1000 });
  if (!toast) return;
  if (payload.question) {
    const q = document.createElement('div');
    q.className = 'appr-question';
    q.textContent = payload.question;
    toast.appendChild(q);
  }
  toast.appendChild(optionButtons(questionId, payload.options ?? [], () => dismissInboxToast(questionId)));
  inboxToasts.set(questionId, toast);
}

/** Live push while a tab is open. */
export function handleApprovalEvent(msg: Record<string, unknown>): void {
  showInboxApproval(msg as Parameters<typeof showInboxApproval>[0]);
}

/** Catch up on approvals queued while offline. Called on every (re)connect. */
export async function fetchPendingApprovals(): Promise<void> {
  try {
    const data = (await apiJson('/api/approvals/pending')) as {
      approvals: Array<{ questionId: string; title: string; options: ApprovalOption[] }>;
    };
    for (const a of data.approvals ?? []) showInboxApproval(a);
  } catch {
    /* next reconnect retries */
  }
}
