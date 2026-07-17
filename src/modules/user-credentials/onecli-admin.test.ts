import { describe, it, expect, vi } from 'vitest';

// Mimic execFile's real non-zero-exit rejection: the Error's message + cmd embed
// the FULL argv (including `--value <secret>`). The onecli() wrapper must scrub
// this so a member's plaintext key can never reach the host log via err.message.
// Regression guard for the user-creds-adversarial-review (cred-storage) finding.
vi.mock('child_process', () => ({
  execFile: vi.fn(
    (
      _cmd: string,
      args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, res?: { stdout: string; stderr: string }) => void,
    ) => {
      const err = new Error(`Command failed: onecli ${args.join(' ')}`) as Error & {
        cmd?: string;
        code?: number;
        stderr?: string;
      };
      err.cmd = `onecli ${args.join(' ')}`;
      err.code = 1;
      // onecli echoes its error REASON, not the received value — but simulate the
      // worst case (the secret present in stderr) to prove the wrapper redacts it.
      const vidx = args.indexOf('--value');
      err.stderr = `gateway rejected request; value=${vidx >= 0 ? args[vidx + 1] : ''}`;
      cb(err);
    },
  ),
}));

import { execFile } from 'child_process';
import { homedir } from 'os';
const mockExecFile = vi.mocked(execFile);

const { realOnecliAdmin } = await import('./onecli-admin.js');

const SECRET = 'sk-ant-api03-REGRESSION-SECRET-DO-NOT-LEAK-000';

function errorSurface(e: unknown): string {
  const err = e as Error;
  return `${err.message} ${err.stack ?? ''} ${JSON.stringify(e, Object.getOwnPropertyNames(err))}`;
}

describe('onecli() env', () => {
  it('passes a resolved HOME to execFile even when the process env lacks one', async () => {
    // Regression: a bare systemd service env (no HOME) made onecli read no auth
    // config → "Unauthorized" (exit 2). The wrapper must inject a resolved HOME.
    const saved = process.env.HOME;
    delete process.env.HOME;
    try {
      await realOnecliAdmin.createAnthropicSecret('t', 'sk-ant-x').catch(() => {});
      const opts = mockExecFile.mock.calls.at(-1)?.[2] as { env?: Record<string, string> } | undefined;
      expect(opts?.env?.HOME).toBe(homedir());
    } finally {
      if (saved !== undefined) process.env.HOME = saved;
    }
  });
});

describe('onecli() wrapper scrubs credentials from errors', () => {
  it('createAnthropicSecret rejection surfaces the reason but redacts the plaintext key', async () => {
    let caught: unknown;
    try {
      await realOnecliAdmin.createAnthropicSecret('UserCreds test', SECRET);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    // The plaintext key must never appear — not in message, stack, or props —
    // even though the simulated stderr echoed it back.
    expect(errorSurface(caught)).not.toContain(SECRET);
    // …but the reason IS surfaced (diagnosable), with the value redacted to ***.
    const msg = (caught as Error).message;
    expect(msg).toContain('onecli secrets create failed (exit 1)');
    expect(msg).toContain('gateway rejected request');
    expect(msg).toContain('***');
  });

  it('updateSecretValue rejection never exposes the plaintext key', async () => {
    let caught: unknown;
    try {
      await realOnecliAdmin.updateSecretValue('sec-1', SECRET);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(errorSurface(caught)).not.toContain(SECRET);
  });
});
