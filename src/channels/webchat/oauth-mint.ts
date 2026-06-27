/**
 * Browser-driven Claude OAuth token mint.
 *
 * Lets a member obtain a `claude setup-token` (sk-ant-oat…) entirely from the
 * webchat UI — no terminal. `claude setup-token` is an interactive raw-mode TUI
 * that demands a real PTY, so we run it inside a throwaway agent container under
 * `script(1)`: `script` allocates the PTY *in* the container, so the host side
 * is plain `docker run -i` with pipes (no node-pty, no host TTY). The server:
 *   1. spawns the container, scrapes the sign-in URL from its output,
 *   2. hands the URL to the browser; the user signs in and pastes the code back,
 *   3. writes the code to the container's stdin, scrapes the printed token,
 *   4. RETURNS the token to the caller.
 *
 * This module only *produces* the token (captured server-side, never round-
 * tripped through the browser). The BYOK onboard path decides what to do with
 * it — storing it as the member's per-member Anthropic vault secret via
 * onboardByokOauth. Keeping mint and storage separate is deliberate: the same
 * mint can later feed an operator shared-key path, and BYOK owns the per-member
 * identity wiring.
 */
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'crypto';

import { log } from '../../log.js';
import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { getDefaultContainerImage } from '../../install-slug.js';

/* eslint-disable no-control-regex -- these patterns match the ESC/control bytes
   a PTY capture is full of. */
// CSI sequences (color, cursor moves) — including cursor-column moves like
// ESC[12G that the CLI sprays mid-line and would otherwise split a URL/token.
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Everything <= space (control bytes, CR/LF, tabs, wrap-padding spaces) + DEL.
const CONTROL_AND_SPACE = /[\x00-\x20\x7f]/g;
/* eslint-enable no-control-regex */

// URL: drop escape sequences but KEEP whitespace, so the match stops at the
// space/newline after the URL instead of swallowing trailing text.
function stripEscapes(raw: string): string {
  return raw.replace(CSI, '').replace(OSC, '');
}
// Token: also drop ALL whitespace/control, so a token the PTY wrapped or padded
// mid-string becomes contiguous again. Mirrors setup/lib/captured-token.ts.
function normalizeForToken(raw: string): string {
  return stripEscapes(raw).replace(CONTROL_AND_SPACE, '');
}

// Claude subscription OAuth token: sk-ant-oat<base64url>AA.
const CLAUDE_TOKEN_RE = /sk-ant-oat[A-Za-z0-9_-]{80,500}AA/g;
const URL_RE = /https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/;

interface MintSession {
  id: string;
  userId: string;
  child: ChildProcessWithoutNullStreams;
  buffer: string; // accumulated RAW output (normalized at match time)
  createdAt: number;
}

const sessions = new Map<string, MintSession>();
const URL_TIMEOUT_MS = 30_000;
const TOKEN_TIMEOUT_MS = 120_000;
const SESSION_TTL_MS = 10 * 60 * 1000;

function killSession(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try {
    s.child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  // SIGKILL on the `docker run` client orphans the daemon-managed container, so
  // force-remove it by name too (fire-and-forget; --rm handles the happy path).
  execFile(CONTAINER_RUNTIME_BIN, ['rm', '-f', `nanoclaw-mint-${id}`], () => {});
}

function findUrl(buffer: string): string | null {
  const m = stripEscapes(buffer).match(URL_RE);
  return m ? m[0] : null;
}

function findTokenSince(buffer: string, rawOffset: number): string | null {
  const ms = normalizeForToken(buffer.slice(rawOffset)).match(CLAUDE_TOKEN_RE);
  // LAST match — setup-token can echo intermediate output before the final token.
  return ms ? ms[ms.length - 1] : null;
}

// Reap abandoned sessions (browser closed mid-flow, etc.).
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) {
      log.warn('Reaping stale OAuth-mint session', { id });
      killSession(id);
    }
  }
}, 60_000).unref();

/**
 * Start a mint: spawn the container, return the sign-in URL once it appears.
 * One active session per user — a new start kills the user's previous.
 */
export async function startClaudeMint(userId: string): Promise<{ sessionId: string; url: string }> {
  for (const [id, s] of sessions) if (s.userId === userId) killSession(id);

  const image = getDefaultContainerImage();
  const id = randomUUID();
  // script(1) gives the TUI a PTY inside the container; host side stays pipes.
  // `stty cols` widens the PTY first so the long URL and the printed token don't
  // wrap (a wrap truncates the URL → "Missing redirect_uri", or chops the token).
  const child = spawn(
    CONTAINER_RUNTIME_BIN,
    [
      'run',
      '-i',
      '--rm',
      '--name',
      `nanoclaw-mint-${id}`,
      '--entrypoint',
      'script',
      image,
      '-qec',
      'stty cols 4000 2>/dev/null; claude setup-token',
      '/dev/null',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;

  const session: MintSession = { id, userId, child, buffer: '', createdAt: Date.now() };
  sessions.set(id, session);
  log.info('OAuth mint: started', { sessionId: id });

  const onData = (chunk: Buffer): void => {
    session.buffer += chunk.toString();
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (err) => log.warn('OAuth mint: spawn error', { sessionId: id, err: err.message }));

  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      log.warn('OAuth mint: timed out waiting for URL', { sessionId: id });
      killSession(id);
      reject(new Error('Timed out waiting for the sign-in URL.'));
    }, URL_TIMEOUT_MS);

    const poll = setInterval(() => {
      const url = findUrl(session.buffer);
      if (url) {
        clearInterval(poll);
        clearTimeout(deadline);
        log.info('OAuth mint: URL ready', { sessionId: id });
        resolve({ sessionId: id, url });
      }
    }, 250);

    child.on('exit', () => {
      clearInterval(poll);
      clearTimeout(deadline);
      if (!findUrl(session.buffer)) {
        log.warn('OAuth mint: process exited before a URL appeared', { sessionId: id });
        killSession(id);
        reject(new Error('Sign-in process exited before producing a URL.'));
      }
    });
  });
}

/**
 * Submit the auth code and return the captured token. Does NOT store it — the
 * caller (BYOK onboard) owns persistence. Kills the session on the way out.
 */
export async function mintClaudeToken(userId: string, sessionId: string, code: string): Promise<string> {
  const session = sessions.get(sessionId);
  if (!session || session.userId !== userId) throw new Error('No active sign-in session.');

  const rawLenBefore = session.buffer.length;
  // `claude setup-token` is a raw-mode TUI (Ink) — it registers Enter as a
  // carriage return, not a newline. '\n' leaves the code in the field
  // unsubmitted; '\r' actually submits it.
  session.child.stdin.write(code.trim() + '\r');
  log.info('OAuth mint: code submitted', { sessionId });

  try {
    return await new Promise<string>((resolve, reject) => {
      const finish = (): void => {
        clearInterval(poll);
        clearTimeout(deadline);
      };
      const deadline = setTimeout(() => {
        finish();
        log.warn('OAuth mint: timed out waiting for token', { sessionId });
        reject(new Error('Timed out waiting for the token. The code may be wrong or expired.'));
      }, TOKEN_TIMEOUT_MS);

      const poll = setInterval(() => {
        const t = findTokenSince(session.buffer, rawLenBefore);
        if (t) {
          finish();
          resolve(t);
        }
      }, 250);

      session.child.on('exit', () => {
        const t = findTokenSince(session.buffer, rawLenBefore);
        finish();
        if (t) {
          resolve(t);
        } else {
          log.warn('OAuth mint: process exited without a token', { sessionId });
          reject(new Error('Sign-in finished without producing a token. The code may be wrong or expired.'));
        }
      });
    });
  } finally {
    killSession(sessionId);
  }
}

export function cancelMint(userId: string, sessionId: string): void {
  const s = sessions.get(sessionId);
  if (s && s.userId === userId) killSession(sessionId);
}
