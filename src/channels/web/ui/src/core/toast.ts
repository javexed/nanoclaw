// ── Toasts ───────────────────────────────────────────────────────────────────
// The UI's only notification primitive (~330 call sites). Depends on core/dom
// and nothing else, so it stays a leaf: modules import it, it imports no
// feature code.
import { $ } from './dom.js';

export type ToastKind = 'info' | 'success' | 'error';

export function showToast(
  message: string,
  { kind = 'info', timeout }: { kind?: ToastKind; timeout?: number } = {},
): HTMLElement | null {
  const container = $('#toasts');
  if (!container) return null;
  const toast = document.createElement('div');
  toast.className = `toast toast-${kind}`;
  toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  toast.textContent = message;
  const remove = (): void => {
    if (!toast.parentNode) return;
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 180);
  };
  // Dismiss on a click of the toast surface itself — not one bubbling up from
  // an interactive child (e.g. an approval card's buttons), which must own their
  // own click semantics.
  toast.addEventListener('click', (e) => {
    if (e.target === toast) remove();
  });
  container.appendChild(toast);
  const ms = timeout ?? (kind === 'error' ? 7000 : 4000);
  setTimeout(remove, ms);
  return toast;
}

/** Error → toast, one shape everywhere (kind:'error' can't be forgotten). */
export function toastError(err: unknown, fallback?: string): void {
  const message = (err as { message?: string } | null)?.message;
  showToast(message || fallback || 'Something went wrong', { kind: 'error' });
}
