// ── Toasts ───────────────────────────────────────────────────────────────────
// The UI's only notification primitive (~330 call sites). Depends on core/dom
// and nothing else, so it stays a leaf: modules import it, it imports no
// feature code.
import { $ } from './dom.js';
export function showToast(message, { kind = 'info', timeout } = {}) {
    const container = $('#toasts');
    if (!container)
        return null;
    const toast = document.createElement('div');
    toast.className = `toast toast-${kind}`;
    toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    toast.textContent = message;
    const remove = () => {
        if (!toast.parentNode)
            return;
        toast.classList.add('toast-out');
        setTimeout(() => toast.remove(), 180);
    };
    toast.addEventListener('click', remove);
    container.appendChild(toast);
    const ms = timeout ?? (kind === 'error' ? 7000 : 4000);
    setTimeout(remove, ms);
    return toast;
}
/** Error → toast, one shape everywhere (kind:'error' can't be forgotten). */
export function toastError(err, fallback) {
    const message = err?.message;
    showToast(message || fallback || 'Something went wrong', { kind: 'error' });
}
