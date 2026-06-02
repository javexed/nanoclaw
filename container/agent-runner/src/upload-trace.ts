import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { MessageInRow } from './db/messages-in.js';

/**
 * `/upload-trace` command: upload this session's Claude Code transcript to the user's
 * own private `{hf_user}/nanoclaw-traces` dataset, browsable in the HF Agent
 * Trace Viewer. The transcript the Claude provider keeps under
 * `~/.claude/projects/<dir>/<sessionId>.jsonl` is already in the format the
 * viewer auto-detects, so this just locates the newest one and pushes it.
 *
 * Auth is the OneCLI gateway's job: curl goes out through the injected
 * HTTPS_PROXY, which adds the user's HF token. We never see the raw token, and
 * a 401 from `whoami` is our "not signed in" signal.
 */

/**
 * Narrow check for /upload-trace — the runner handles this command directly
 * (no LLM turn). Admin-gated by the host router before it reaches the container.
 */
export function isUploadTraceCommand(msg: MessageInRow): boolean {
  let text = '';
  try {
    text = (JSON.parse(msg.content)?.text ?? '').trim();
  } catch {
    return false; // non-JSON content is never a command
  }
  return text.toLowerCase().startsWith('/upload-trace');
}

/** Newest Claude Code transcript jsonl (the current session). */
function newestTranscript(): string | null {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  let best: { p: string; m: number } | null = null;
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    let files: string[];
    try {
      files = fs.readdirSync(path.join(projects, dir));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(projects, dir, f);
      const m = fs.statSync(p).mtimeMs;
      if (!best || m > best.m) best = { p, m };
    }
  }
  return best?.p ?? null;
}

function curl(args: string[], input?: string): { ok: boolean; out: string } {
  const r = spawnSync('curl', args, { input, encoding: 'utf-8' });
  return { ok: r.status === 0, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

/** Returns a user-facing status line. Never throws. */
export function uploadTrace(): string {
  const file = newestTranscript();
  if (!file) return 'No transcript to upload for this session yet.';

  const who = curl(['-sf', 'https://huggingface.co/api/whoami-v2']);
  if (!who.ok) {
    return [
      "Can't upload — no Hugging Face token is available to this agent. To set it up:",
      '',
      '1. Create a token with WRITE access at https://huggingface.co/settings/tokens',
      '   (New token → type "Write" → copy it).',
      '',
      '2. Add it to the OneCLI vault. Open the dashboard — remotely at https://app.onecli.sh/',
      '   or on the host at http://127.0.0.1:10254 — then Secrets → New secret,',
      '   paste the token, and set the host pattern to  huggingface.co',
      '',
      '3. Assign it to this agent — new agents start with no secrets attached.',
      '   In the same dashboard, open this agent and set its secret mode to "all"; or from the host run:',
      '     onecli agents list                                   # find this agent\'s id',
      '     onecli agents set-secret-mode --id <agent-id> --mode all',
      '',
      'Then run /upload-trace again — no restart needed.',
    ].join('\n');
  }
  let user: string | undefined;
  try {
    user = JSON.parse(who.out)?.name;
  } catch {
    /* fall through */
  }
  if (!user) return 'Could not resolve your Hugging Face username.';

  const repo = `${user}/nanoclaw-traces`;
  // Idempotent create — ignore failure (already exists / no-op). The
  // Content-Type header is required: without it curl sends form-encoding and
  // the Hub rejects the body with 400 (expected string at "name").
  curl([
    '-sf',
    '-X',
    'POST',
    'https://huggingface.co/api/repos/create',
    '-H',
    'Content-Type: application/json',
    '-d',
    JSON.stringify({ type: 'dataset', name: 'nanoclaw-traces', private: true }),
  ]);

  const content = fs.readFileSync(file).toString('base64');
  const repoPath = `sessions/${path.basename(file)}`;
  const ndjson =
    JSON.stringify({ key: 'header', value: { summary: 'add session trace' } }) +
    '\n' +
    JSON.stringify({
      key: 'file',
      value: { path: repoPath, encoding: 'base64', content },
    }) +
    '\n';

  const commit = curl(
    [
      '-sf',
      '-X',
      'POST',
      `https://huggingface.co/api/datasets/${repo}/commit/main`,
      '-H',
      'Content-Type: application/x-ndjson',
      '--data-binary',
      '@-',
    ],
    ndjson,
  );
  if (!commit.ok) {
    return 'Upload to Hugging Face failed (the transcript may be too large for an inline commit).';
  }
  return `Uploaded → https://huggingface.co/datasets/${repo}/blob/main/${repoPath}`;
}
