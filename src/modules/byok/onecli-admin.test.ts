import { describe, it, expect, vi } from 'vitest';

// Mimic execFile's real non-zero-exit rejection: the Error's message + cmd embed
// the FULL argv (including `--value <secret>`). The onecli() wrapper must scrub
// this so a member's plaintext key can never reach the host log via err.message.
// Regression guard for the byok-adversarial-review (cred-storage) finding.
vi.mock('child_process', () => ({
  execFile: (
    _cmd: string,
    args: readonly string[],
    _opts: unknown,
    cb: (err: Error | null, res?: { stdout: string; stderr: string }) => void,
  ) => {
    const err = new Error(`Command failed: onecli ${args.join(' ')}`) as Error & { cmd?: string; code?: number };
    err.cmd = `onecli ${args.join(' ')}`;
    err.code = 1;
    cb(err);
  },
}));

const { realOnecliAdmin } = await import('./onecli-admin.js');

const SECRET = 'sk-ant-api03-REGRESSION-SECRET-DO-NOT-LEAK-000';

function errorSurface(e: unknown): string {
  const err = e as Error;
  return `${err.message} ${err.stack ?? ''} ${JSON.stringify(e, Object.getOwnPropertyNames(err))}`;
}

describe('onecli() wrapper scrubs credentials from errors', () => {
  it('createAnthropicSecret rejection never exposes the plaintext key, and names only resource/verb', async () => {
    let caught: unknown;
    try {
      await realOnecliAdmin.createAnthropicSecret('BYOK test', SECRET);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(errorSurface(caught)).not.toContain(SECRET);
    expect((caught as Error).message).toBe('onecli secrets create failed (exit 1)');
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
