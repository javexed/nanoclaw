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
 * (onboardByokOauth → an `anthropic` secret for Claude, an `openai` auth.json
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

function findTokenSince(buffer: string, rawOffset: number): string | null {
  const ms = normalizeForToken(buffer.slice(rawOffset)).match(CLAUDE_TOKEN_RE);
  // LAST match — setup-token can echo intermediate output before the final token.
  return ms ? ms[ms.length - 1] : null;
}

/**
 * Redacted summary of a capture for diagnosing a failed mint — masks any sk-ant
 * token (length only, never the value) but keeps surrounding text like "Invalid
 * code" so we can tell a rejected code from a token printed in an unexpected
 * shape. Temporary diagnostic.
 */
function diagnoseCapture(rawSince: string): Record<string, unknown> {
  const normalized = normalizeForToken(rawSince);
  const oat = normalized.match(/sk-ant-oat[A-Za-z0-9_-]+/); // loose: token present at all?
  const tail = stripEscapes(rawSince)
    .replace(/\s+/g, ' ')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, (m) => `sk-ant-…[${m.length}ch]`)
    .slice(-500);
  return {
    rawLen: rawSince.length,
    hasOatPrefix: !!oat,
    looseOatLen: oat ? oat[0].length : 0,
    strictRegexMatched: !!normalized.match(CLAUDE_TOKEN_RE),
    tail,
  };
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
        log.warn('OAuth mint: timed out waiting for token', {
          sessionId,
          ...diagnoseCapture(session.buffer.slice(rawLenBefore)),
        });
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
          log.warn('OAuth mint: code rejected', { sessionId, ...diagnoseCapture(session.buffer.slice(rawLenBefore)) });
          reject(new Error('That code was rejected — copy the full code from the sign-in page and try again.'));
        }
      }, 250);

      session.child.on('exit', () => {
        const t = findTokenSince(session.buffer, rawLenBefore);
        finish();
        if (t) {
          resolve(t);
        } else {
          log.warn('OAuth mint: process exited without a token', {
            sessionId,
            ...diagnoseCapture(session.buffer.slice(rawLenBefore)),
          });
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

  const onData = (chunk: Buffer): void => {
    session.buffer += chunk.toString();
  };
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
