// ── Login gate ───────────────────────────────────────────────────────────────
// Localhost installs auto-pass and never see this screen. A bearer install
// shows the token form until /api/auth/check succeeds; the token lives in
// sessionStorage (scope, not secrecy — the CSP and sanitizer own XSS defense).
import { $ } from '../core/dom.js';
import { authFetch, getAuthToken, setAuthToken } from '../core/api.js';

export async function ensureAuthenticated(): Promise<void> {
  if (await checkAuth()) return;
  await showLogin();
}

async function checkAuth(): Promise<boolean> {
  try {
    const res = await authFetch('/api/auth/check');
    return res.ok;
  } catch {
    return false;
  }
}

function showLogin(): Promise<void> {
  return new Promise((resolve) => {
    const screen = $('#login-screen')!;
    const form = $('#login-form') as HTMLFormElement;
    const input = $('#login-token') as HTMLInputElement;
    const error = $('#login-error')!;
    screen.hidden = false;
    $('#app')!.hidden = true;
    input.focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const token = input.value.trim();
      if (!token) return;
      setAuthToken(token);
      if (await checkAuth()) {
        sessionStorage.setItem('nanoclaw-token', token);
        screen.hidden = true;
        $('#app')!.hidden = false;
        resolve();
      } else {
        setAuthToken(getAuthToken() === token ? '' : getAuthToken());
        error.textContent = 'That token was not accepted.';
        error.hidden = false;
      }
    });
  });
}
