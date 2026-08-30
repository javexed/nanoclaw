/**
 * Browser-driven Claude sign-in — the install credential, minted without a terminal.
 *
 * Ported from the predecessor webchat's oauth-mint (Claude half only; this build
 * has no per-member credentials, so the captured token becomes the install-wide
 * anthropic secret in the OneCLI vault). The flow runs `claude setup-token` in a
 * throwaway agent container under `script(1)` (PTY inside the container; host
 * side is plain `docker run -i` with pipes) and `stty cols 4000` so the long
 * sign-in URL doesn't wrap. start scrapes the URL; the user signs in and pastes
 * a code back; finish writes the code to stdin, scrapes the printed token off a
 * terminal-emulated reconstruction of the screen, and stores it in the vault.
 */
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

import { log } from '../../log.js';
import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { getDefaultContainerImage } from '../../install-slug.js';

/* eslint-disable no-control-regex -- these patterns match the ESC/control bytes
   a PTY capture is full of. */
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/* eslint-enable no-control-regex */

function stripEscapes(raw: string): string {
  return raw.replace(CSI, '').replace(OSC, '');
}

/**
 * Reconstruct the on-screen text from raw PTY output by EMULATING the terminal.
 *
 * `claude setup-token` renders via Ink, which frame-diffs: it rewrites only the
 * columns that changed between frames and uses cursor-positioning escapes to
 * jump over columns it left untouched. So the token does NOT appear linearly in
 * the byte stream — the only faithful recovery is to apply the moves to a grid,
 * exactly as the user's terminal does, then read the resulting lines.
 */
function renderTerminal(raw: string): string {
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
      let j = i + 2;
      let params = '';
      while (j < raw.length && /[0-9;?]/.test(raw[j])) params += raw[j++];
      while (j < raw.length && raw[j] >= ' ' && raw[j] <= '/') j++;
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
      }
      clamp();
      i = j + 1;
      continue;
    }
    if (ch === '\x1b' && raw[i + 1] === ']') {
      let j = i + 2;
      while (j < raw.length && raw[j] !== '\x07' && !(raw[j] === '\x1b' && raw[j + 1] === '\\')) j++;
      i = raw[j] === '\x07' ? j + 1 : j + 2;
      continue;
    }
    if (ch === '\x1b') {
      i += 2;
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
      i++;
      continue;
    }
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

// Claude subscription OAuth token: `sk-ant-oat01-<base64url>…`, ~108 chars.
const CLAUDE_TOKEN_RE = /sk-ant-[A-Za-z0-9_-]{40,}/g;
const URL_RE = /https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/;

interface MintSession {
  id: string;
  child: ChildProcessWithoutNullStreams;
  buffer: string;
  createdAt: number;
}

// Single-user install: at most one active sign-in; a new start kills the prior.
const sessions = new Map<string, MintSession>();
const URL_TIMEOUT_MS = 30_000;
const TOKEN_TIMEOUT_MS = 120_000;
const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_BUFFER_BYTES = 1_000_000;
const MAX_CODE_LEN = 512;

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
  // SIGKILL on the `docker run` client orphans the daemon-managed container.
  execFile(CONTAINER_RUNTIME_BIN, ['rm', '-f', `nanoclaw-mint-${id}`], () => {});
}

function findUrl(buffer: string): string | null {
  const m = stripEscapes(buffer).match(URL_RE);
  return m ? m[0] : null;
}

function findToken(buffer: string): string | null {
  // LAST match — setup-token echoes intermediate output before the final token.
  const ms = renderTerminal(buffer).match(CLAUDE_TOKEN_RE);
  return ms ? ms[ms.length - 1] : null;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) {
      log.warn('Reaping stale Claude sign-in session', { id });
      killSession(id);
    }
  }
}, 30_000).unref();

/** Start a sign-in: spawn the container, return the URL once it appears. */
export async function startClaudeSignin(): Promise<{ sessionId: string; url: string }> {
  for (const id of sessions.keys()) killSession(id);

  const image = getDefaultContainerImage();
  const id = randomUUID();
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

  const session: MintSession = { id, child, buffer: '', createdAt: Date.now() };
  sessions.set(id, session);
  log.info('Claude sign-in: started', { sessionId: id });

  const onData = (chunk: Buffer): void => appendBuffer(session, chunk);
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (err) => log.warn('Claude sign-in: spawn error', { sessionId: id, err: err.message }));

  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      log.warn('Claude sign-in: timed out waiting for URL', { sessionId: id });
      killSession(id);
      reject(new Error('Timed out waiting for the sign-in URL.'));
    }, URL_TIMEOUT_MS);

    const poll = setInterval(() => {
      const url = findUrl(session.buffer);
      if (url) {
        clearInterval(poll);
        clearTimeout(deadline);
        log.info('Claude sign-in: URL ready', { sessionId: id });
        resolve({ sessionId: id, url });
      }
    }, 250);

    child.on('exit', () => {
      clearInterval(poll);
      clearTimeout(deadline);
      if (!findUrl(session.buffer)) {
        log.warn('Claude sign-in: process exited before a URL appeared', { sessionId: id });
        killSession(id);
        reject(new Error('Sign-in process exited before producing a URL.'));
      }
    });
  });
}

/** Submit the pasted code, capture the token. Kills the session on the way out. */
export async function finishClaudeSignin(sessionId: string, code: string): Promise<string> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('No active sign-in session.');
  if (code.length > MAX_CODE_LEN) throw new Error('That code is too long — paste only the code from the sign-in page.');

  const rawLenBefore = session.buffer.length;
  // Ink treats `code + '\r'` in one chunk as a bulk paste (CR lands IN the
  // field). Send the code, then Enter as a separate keystroke a beat later.
  session.child.stdin.write(code.trim());
  setTimeout(() => {
    try {
      session.child.stdin.write('\r');
    } catch {
      /* process already gone */
    }
  }, 150);
  log.info('Claude sign-in: code submitted', { sessionId });

  try {
    return await new Promise<string>((resolve, reject) => {
      const finish = (): void => {
        clearInterval(poll);
        clearTimeout(deadline);
      };
      const deadline = setTimeout(() => {
        finish();
        reject(new Error('Timed out waiting for the token. The code may be wrong or expired.'));
      }, TOKEN_TIMEOUT_MS);

      const poll = setInterval(() => {
        const t = findToken(session.buffer);
        if (t) {
          finish();
          resolve(t);
          return;
        }
        // setup-token keeps the prompt open after a bad code — fail fast on its
        // error screen instead of waiting out the full timeout.
        const since = stripEscapes(session.buffer.slice(rawLenBefore));
        if (/OAuth error|Invalid|expired/i.test(since)) {
          finish();
          reject(new Error('That code was rejected — copy the full code from the sign-in page and try again.'));
        }
      }, 250);

      session.child.on('exit', () => {
        const t = findToken(session.buffer);
        finish();
        if (t) resolve(t);
        else reject(new Error('Sign-in finished without producing a token. The code may be wrong or expired.'));
      });
    });
  } finally {
    killSession(sessionId);
  }
}

export function cancelClaudeSignin(sessionId: string): void {
  killSession(sessionId);
}

// ── Vault storage ───────────────────────────────────────────────────────────

function onecli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('onecli', args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

interface VaultSecret {
  id: string;
  type?: string;
}

async function listAnthropicSecrets(): Promise<VaultSecret[]> {
  const out = await onecli(['secrets', 'list']);
  const parsed = JSON.parse(out) as { data?: VaultSecret[] };
  return (parsed.data ?? []).filter((s) => s.type === 'anthropic');
}

/** Is an install-wide Claude credential present in the vault? */
export async function hasClaudeCredential(): Promise<boolean> {
  try {
    return (await listAnthropicSecrets()).length > 0;
  } catch {
    return false;
  }
}

/**
 * Hand a secret to onecli via a 0600 temp file rather than --value: process
 * arguments are world-readable through /proc/<pid>/cmdline while onecli runs,
 * which would leak the install credential to any local process. onecli reads
 * the value off disk with --file; the temp file is unlinked immediately.
 */
async function withSecretFile<T>(content: string, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'nc-secret-'));
  const path = join(dir, 'value');
  writeFileSync(path, content, { mode: 0o600 });
  try {
    return await fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Persist the minted token: update the existing anthropic secret in place
 * (agents already reference it) or create the install's first one.
 */
export async function storeClaudeCredential(token: string): Promise<void> {
  const existing = await listAnthropicSecrets().catch(() => []);
  if (existing.length > 0) {
    await withSecretFile(token, (path) => onecli(['secrets', 'update', '--id', existing[0].id, '--file', path]));
    log.info('Claude sign-in: vault secret updated', { secretId: existing[0].id });
    return;
  }
  await withSecretFile(token, (path) =>
    onecli([
      'secrets',
      'create',
      '--name',
      'NanoClaw webchat',
      '--type',
      'anthropic',
      '--file',
      path,
      '--host-pattern',
      'api.anthropic.com',
    ]),
  );
  log.info('Claude sign-in: vault secret created');
}
