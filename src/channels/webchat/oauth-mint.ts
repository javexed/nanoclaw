/**
 * Browser-driven OAuth credential mint — Claude (Anthropic) and Codex (ChatGPT).
 *
 * Lets a member connect a subscription credential entirely from the webchat UI —
 * no terminal. Both flows run a CLI inside a throwaway agent container under
 * `script(1)` (PTY in the container; host side is plain `docker run -i` with
 * pipes — no node-pty, no host TTY) and `stty cols 4000` so the long URL doesn't
 * wrap. The two providers have genuinely different credential shapes, so they
 * have separate start/finish calls:
 *
 *   Claude — `claude setup-token` is a raw-mode TUI that prints an sk-ant-oat…
 *     token. start scrapes the sign-in URL; the user signs in and pastes a code
 *     back; finish writes the code to stdin and scrapes the printed TOKEN STRING.
 *
 *   Codex — `codex login --device-auth` is the headless device flow: it prints a
 *     URL + pairing code, the user enters the code at OpenAI's site (nothing is
 *     pasted back here), and on approval it writes a whole `auth.json` to a
 *     throwaway CODEX_HOME mounted from the host. start scrapes the URL (+ code);
 *     finish waits for `auth.json` to appear and returns its CONTENTS.
 *
 * This module only *produces* the credential (captured server-side, never round-
 * tripped through the browser). The BYOK onboard path decides what to do with it
 * (storeUserCredential → an `anthropic` secret for Claude, an `openai` auth.json
 * secret for Codex). Keeping mint and storage separate is deliberate: the same
 * mint can later feed an operator shared-key path, and BYOK owns the per-member
 * identity wiring.
 */
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { log } from '../../log.js';
import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { getDefaultContainerImage } from '../../install-slug.js';

/* eslint-disable no-control-regex -- these patterns match the ESC/control bytes
   a PTY capture is full of. */
// CSI sequences (color, cursor moves) — including cursor-column moves like
// ESC[12G that the CLI sprays mid-line and would otherwise split a URL/token.
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/* eslint-enable no-control-regex */

// URL: drop escape sequences but KEEP whitespace, so the match stops at the
// space/newline after the URL instead of swallowing trailing text. (The token
// is recovered separately via full terminal emulation — see renderTerminal.)
function stripEscapes(raw: string): string {
  return raw.replace(CSI, '').replace(OSC, '');
}

/**
 * Reconstruct the on-screen text from raw PTY output by EMULATING the terminal.
 *
 * `claude setup-token` renders via Ink, which frame-diffs: it rewrites only the
 * columns that changed between frames and uses cursor-positioning escapes
 * (CHA `ESC[<n>G`, CUF `ESC[<n>C`, …) to jump over columns it left untouched.
 * So the token does NOT appear linearly in the byte stream — naive escape
 * stripping concatenates the written runs and silently drops the skipped
 * columns (e.g. the `o` in `sk-ant-oat01-…`). The only faithful recovery is to
 * apply the moves to a grid, exactly as the user's terminal does, then read the
 * resulting lines. Handles the horizontal/vertical moves + erases Ink emits;
 * other CSI/OSC (color, etc.) are no-ops for layout and skipped.
 */
function renderTerminal(raw: string): string {
  // Bounds so a malformed/hostile cursor move (e.g. ESC[9999999G) can't allocate
  // an enormous grid. Generous vs the real layout (stty cols 4000, a few rows).
  const MAX_COL = 8192;
  const MAX_ROW = 4096;
  const grid: string[][] = [];
  let row = 0;
  let col = 0;
  const ensure = (r: number, c: number): void => {
    while (grid.length <= r) grid.push([]);
    const line = grid[r];
    while (line.length <= c) line.push(' ');
  };
  const num = (s: string, def = 1): number => {
    const n = parseInt(s, 10);
    return Number.isNaN(n) ? def : n;
  };
  const clamp = (): void => {
    if (col < 0) col = 0;
    else if (col > MAX_COL) col = MAX_COL;
    if (row < 0) row = 0;
    else if (row > MAX_ROW) row = MAX_ROW;
  };
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '\x1b' && raw[i + 1] === '[') {
      // CSI: ESC [ params intermediates final
      let j = i + 2;
      let params = '';
      while (j < raw.length && /[0-9;?]/.test(raw[j])) params += raw[j++];
      while (j < raw.length && raw[j] >= ' ' && raw[j] <= '/') j++; // intermediates
      const final = raw[j];
      const p0 = params.split(';')[0] ?? '';
      switch (final) {
        case 'A':
          row = Math.max(0, row - num(p0));
          break;
        case 'B':
          row += num(p0);
          break;
        case 'C':
          col += num(p0);
          break;
        case 'D':
          col = Math.max(0, col - num(p0));
          break;
        case 'G':
          col = num(p0) - 1;
          break;
        case 'H':
        case 'f': {
          const parts = params.split(';');
          row = num(parts[0] ?? '') - 1;
          col = num(parts[1] ?? '') - 1;
          break;
        }
        case 'K': {
          ensure(row, col);
          const mode = num(p0, 0);
          if (mode === 0) grid[row].length = col;
          else if (mode === 1) for (let c = 0; c <= col; c++) grid[row][c] = ' ';
          else grid[row] = [];
          break;
        }
        case 'J':
          if (num(p0, 0) === 2) {
            grid.length = 0;
            row = 0;
            col = 0;
          }
          break;
        // color (m), private modes (h/l), etc. — no layout effect.
      }
      clamp();
      i = j + 1;
      continue;
    }
    if (ch === '\x1b' && raw[i + 1] === ']') {
      // OSC: skip to BEL or ST.
      let j = i + 2;
      while (j < raw.length && raw[j] !== '\x07' && !(raw[j] === '\x1b' && raw[j + 1] === '\\')) j++;
      i = raw[j] === '\x07' ? j + 1 : j + 2;
      continue;
    }
    if (ch === '\x1b') {
      i += 2; // other two-byte escape (ESC M, ESC =, …)
      continue;
    }
    if (ch === '\r') {
      col = 0;
      i++;
      continue;
    }
    if (ch === '\n') {
      row++;
      clamp();
      i++;
      continue;
    }
    if (ch === '\b') {
      col = Math.max(0, col - 1);
      i++;
      continue;
    }
    if (ch < ' ' || ch === '\x7f') {
      i++; // other control byte — no layout effect
      continue;
    }
    // Drop writes past the bounds rather than allocating an enormous grid.
    if (col > MAX_COL || row > MAX_ROW) {
      i++;
      continue;
    }
    ensure(row, col);
    grid[row][col] = ch;
    col++;
    i++;
  }
  return grid.map((line) => line.join('').replace(/\s+$/, '')).join('\n');
}

// Claude subscription OAuth token: `sk-ant-oat01-<base64url>…AA`, ~108 chars.
// Anchored loosely on the `sk-ant-` prefix + a generous length so a future
// format tweak still matches; the token is read off the terminal-emulated
// screen (renderTerminal), not the raw byte stream, so it arrives contiguous.
const CLAUDE_TOKEN_RE = /sk-ant-[A-Za-z0-9_-]{40,}/g;
const URL_RE = /https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/;
// Codex device-auth pairing code, e.g. "ABCD-EFGH". Best-effort: completion is
// detected by auth.json appearing, not by this match, so a format drift here only
// means the UI shows the URL without the code (the URL may already embed it).
const CODEX_CODE_RE = /\b[A-Z0-9]{3,6}-[A-Z0-9]{3,6}\b/;

interface MintSession {
  id: string;
  userId: string;
  child: ChildProcessWithoutNullStreams;
  buffer: string; // accumulated RAW output (normalized at match time)
  createdAt: number;
  home?: string; // Codex only: host temp dir mounted as CODEX_HOME (holds auth.json)
  exited?: number; // epoch-ms the container process exited (for prompt CODEX_HOME shredding)
}

const sessions = new Map<string, MintSession>();
const URL_TIMEOUT_MS = 30_000;
const TOKEN_TIMEOUT_MS = 120_000;
const SESSION_TTL_MS = 10 * 60 * 1000;
// Once the mint container exits, a Codex session's CODEX_HOME still holds a real
// auth.json. finishCodexMint shreds it on success/timeout, but if the browser
// never calls /finish (tab closed), reap it this soon after exit instead of
// waiting out the full TTL. Bounds how long a live credential sits on disk.
const EXITED_GRACE_MS = 90_000;
// Global cap on concurrent mint containers (each is a `docker run`). A new start
// kills the same user's previous session, so this mainly bounds distinct users.
export const MAX_ACTIVE_MINTS = 8;
// Hard cap on captured output. The happy path is a few KB; this only bounds a
// hostile/flooding container (and keeps the per-poll terminal emulation cheap).
const MAX_BUFFER_BYTES = 1_000_000;
// An OAuth setup-token code is short; reject an oversized paste (DoS / abuse).
const MAX_CODE_LEN = 512;

/** Active mint container count — the host gate for the global concurrency cap. */
export function activeMintCount(): number {
  return sessions.size;
}

/** Append container output, bounded so a flooding container can't grow memory. */
function appendBuffer(session: MintSession, chunk: Buffer): void {
  if (session.buffer.length < MAX_BUFFER_BYTES) session.buffer += chunk.toString();
}

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
  // Codex: shred the throwaway CODEX_HOME — it held the captured auth.json.
  if (s.home) {
    try {
      rmSync(s.home, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

function findUrl(buffer: string): string | null {
  const m = stripEscapes(buffer).match(URL_RE);
  return m ? m[0] : null;
}

function findTokenSince(buffer: string, _rawOffset: number): string | null {
  // Match on the RECONSTRUCTED screen (terminal-emulated). Ink frame-diffs with
  // cursor jumps, so the token isn't linear in the stream — and it skips columns
  // it thinks are unchanged from a PRIOR frame. So we must emulate the WHOLE
  // buffer (not just since code-submission) to carry that prior screen state
  // forward; otherwise a skipped column (e.g. the `o` in oat01…) reads as a gap.
  // The token prints unwrapped (stty cols 4000) → one grid line. LAST match —
  // setup-token echoes intermediate output before the final token.
  const ms = renderTerminal(buffer).match(CLAUDE_TOKEN_RE);
  return ms ? ms[ms.length - 1] : null;
}

// Reap abandoned sessions (browser closed mid-flow, etc.). A session whose
// container has already exited is reaped quickly (EXITED_GRACE_MS) so a written
// Codex auth.json doesn't linger; otherwise the full TTL applies.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    const exitedLongEnough = s.exited !== undefined && now - s.exited > EXITED_GRACE_MS;
    if (exitedLongEnough || now - s.createdAt > SESSION_TTL_MS) {
      log.warn('Reaping stale OAuth-mint session', { id });
      killSession(id);
    }
  }
}, 30_000).unref();

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

  const onData = (chunk: Buffer): void => appendBuffer(session, chunk);
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
  if (code.length > MAX_CODE_LEN) throw new Error('That code is too long — paste only the code from the sign-in page.');

  const rawLenBefore = session.buffer.length;
  // `claude setup-token` is a raw-mode TUI (Ink). Writing `code + '\r'` in one
  // chunk reads as a bulk PASTE — Ink inserts the CR into the field instead of
  // submitting, so the code just sits there masked as asterisks and the prompt
  // waits forever (confirmed via capture diagnostics). Send the code first, then
  // Enter as a SEPARATE keystroke a beat later so the field's onSubmit fires.
  session.child.stdin.write(code.trim());
  setTimeout(() => {
    try {
      session.child.stdin.write('\r');
    } catch {
      /* process already gone */
    }
  }, 150);
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
          return;
        }
        // `claude setup-token` keeps the prompt open after a bad code, so fail
        // fast on its error screen instead of waiting out the full timeout.
        // ANSI cursor-moves splice the words, so match against the escape-stripped
        // text (which keeps literal spaces like "OAuth error").
        const since = stripEscapes(session.buffer.slice(rawLenBefore));
        if (/OAuth error|Invalid|expired/i.test(since)) {
          finish();
          log.warn('OAuth mint: code rejected', { sessionId });
          reject(new Error('That code was rejected — copy the full code from the sign-in page and try again.'));
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

/** A written auth.json that parses and carries real credential material. */
function readAuthJson(home: string): string | null {
  const path = join(home, 'auth.json');
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Codex writes a partial file mid-flow; require real credential material.
    if (parsed.tokens || parsed.OPENAI_API_KEY) return raw;
  } catch {
    /* still being written */
  }
  return null;
}

/**
 * Start a Codex device-auth mint: spawn the container, return the verification
 * URL (and pairing code, best-effort) once they appear. The container keeps
 * running and polling OpenAI; finishCodexMint waits for the written auth.json.
 * One active session per user — a new start kills the user's previous.
 */
export async function startCodexMint(
  userId: string,
): Promise<{ sessionId: string; url: string; userCode: string | null }> {
  for (const [id, s] of sessions) if (s.userId === userId) killSession(id);

  const image = getDefaultContainerImage();
  const id = randomUUID();
  // Throwaway CODEX_HOME on the host — codex writes auth.json here; we read it
  // back and shred the dir in killSession. Never the host's own ~/.codex.
  const home = mkdtempSync(join(tmpdir(), 'nanoclaw-codex-mint-'));
  // Run the container as the host uid:gid so the written auth.json is readable
  // back (mirrors setup/get-oauth-token.sh). Fall back to no --user off Linux.
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
  const userArgs = uid !== undefined && gid !== undefined ? ['--user', `${uid}:${gid}`] : [];

  const child = spawn(
    CONTAINER_RUNTIME_BIN,
    [
      'run',
      '-i',
      '--rm',
      '--name',
      `nanoclaw-mint-${id}`,
      ...userArgs,
      '-e',
      'HOME=/codexhome',
      '-e',
      'CODEX_HOME=/codexhome',
      '-v',
      `${home}:/codexhome`,
      '--entrypoint',
      'script',
      image,
      '-qec',
      'stty cols 4000 2>/dev/null; codex login --device-auth',
      '/dev/null',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;

  const session: MintSession = { id, userId, child, buffer: '', createdAt: Date.now(), home };
  sessions.set(id, session);
  log.info('Codex mint: started', { sessionId: id });

  const onData = (chunk: Buffer): void => appendBuffer(session, chunk);
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (err) => log.warn('Codex mint: spawn error', { sessionId: id, err: err.message }));

  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      log.warn('Codex mint: timed out waiting for URL', { sessionId: id });
      killSession(id);
      reject(new Error('Timed out waiting for the sign-in URL. Is the Codex CLI in the agent image (/add-codex)?'));
    }, URL_TIMEOUT_MS);

    const poll = setInterval(() => {
      const url = findUrl(session.buffer);
      if (url) {
        clearInterval(poll);
        clearTimeout(deadline);
        const codeMatch = stripEscapes(session.buffer).match(CODEX_CODE_RE);
        log.info('Codex mint: URL ready', { sessionId: id });
        resolve({ sessionId: id, url, userCode: codeMatch ? codeMatch[0] : null });
      }
    }, 250);

    child.on('exit', () => {
      clearInterval(poll);
      clearTimeout(deadline);
      // Mark exit so the reaper shreds CODEX_HOME promptly if /finish never comes
      // (browser closed after approval). finishCodexMint shreds on its own paths.
      session.exited = Date.now();
      if (!findUrl(session.buffer)) {
        log.warn('Codex mint: process exited before a URL appeared', { sessionId: id });
        killSession(id);
        reject(
          new Error('Sign-in process exited before producing a URL. Is the Codex CLI in the agent image (/add-codex)?'),
        );
      }
    });
  });
}

/**
 * Wait for the member to approve in their browser, then return the captured
 * auth.json contents. Does NOT store it — the caller (BYOK onboard) owns
 * persistence. Kills the session (and shreds CODEX_HOME) on the way out.
 */
export async function finishCodexMint(userId: string, sessionId: string): Promise<string> {
  const session = sessions.get(sessionId);
  if (!session || session.userId !== userId || !session.home) throw new Error('No active sign-in session.');
  const home = session.home;

  try {
    return await new Promise<string>((resolve, reject) => {
      const finish = (): void => {
        clearInterval(poll);
        clearTimeout(deadline);
      };
      const deadline = setTimeout(() => {
        finish();
        log.warn('Codex mint: timed out waiting for auth.json', { sessionId });
        reject(new Error('Timed out waiting for approval. Open the URL, enter the code, and approve — then retry.'));
      }, TOKEN_TIMEOUT_MS);

      const poll = setInterval(() => {
        const authJson = readAuthJson(home);
        if (authJson) {
          finish();
          resolve(authJson);
        }
      }, 250);

      session.child.on('exit', () => {
        const authJson = readAuthJson(home);
        finish();
        if (authJson) {
          resolve(authJson);
        } else {
          log.warn('Codex mint: process exited without an auth.json', { sessionId });
          reject(new Error('Sign-in finished without writing credentials. The code may be wrong or expired.'));
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
