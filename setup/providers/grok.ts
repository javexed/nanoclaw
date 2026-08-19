/**
 * Grok setup surface — picker entry, device-code auth walk-through, install check.
 *
 * THE LOGIN RUNS IN A CONTAINER, not on the host. The grok CLI is part of the
 * agent image, not a host dependency, and running the login anywhere else would
 * authenticate a machine that never talks to xAI. A throwaway container with a
 * host directory mounted at the CLI's home means the credential lands directly
 * on the host, where the split in grok-auth.ts can take the refresh token out
 * of reach before any agent container ever runs.
 *
 * MOUNT/BINARY COLLISION — the reason the CLI must not live under ~/.grok.
 * `install.sh` defaults to installing the binary at ~/.grok/bin/grok, and the
 * provider mounts a host directory over ~/.grok. Left at the default, that
 * mount would hide the very binary it needs and every spawn would fail with
 * "grok: not found". The image therefore installs with GROK_BIN_DIR pointing
 * outside that path (Phase 6), and this file resolves the CLI from PATH rather
 * than the home directory so the two cannot drift back together silently.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { importCliAuthJson, writeSharedCredentials } from '../../src/providers/grok-auth.js';
import { getDefaultContainerImage } from '../../src/install-slug.js';
import { registerSetupProvider } from './registry.js';

/** Where the CLI's home lives inside the container — fixed by the CLI. */
const GROK_HOME = '/home/node/.grok';

/** Payload files that must exist for the provider to be wired. */
export const GROK_PAYLOAD_FILES = [
  'src/providers/grok.ts',
  'src/providers/grok-auth.ts',
  'container/agent-runner/src/providers/grok.ts',
  'container/agent-runner/src/providers/grok-acp.ts',
  'setup/providers/grok.ts',
];

/** Barrels that must carry the registration import. */
export const GROK_BARRELS: Array<{ file: string; needle: string }> = [
  { file: 'src/providers/index.ts', needle: "import './grok.js';" },
  { file: 'container/agent-runner/src/providers/index.ts', needle: "import './grok.js';" },
  { file: 'setup/providers/index.ts', needle: "import './grok.js';" },
];

/**
 * `docker run` args for an interactive device-code login.
 *
 * Split out so the shape is testable without a daemon: the mount target, the
 * `--entrypoint grok` (PATH, never ~/.grok/bin — see the header), and
 * `--no-auto-update` so a login can't be derailed by a background upgrade.
 */
export function buildDeviceLoginArgs(image: string, hostAuthDir: string): string[] {
  return [
    'run',
    '--rm',
    '-i',
    '-v',
    `${hostAuthDir}:${GROK_HOME}`,
    '--entrypoint',
    'grok',
    image,
    '--no-auto-update',
    'login',
    '--device-auth',
  ];
}

/** Read the auth.json a successful login wrote, and convert it to managed credentials. */
export function importLoginResult(hostAuthDir: string): ReturnType<typeof importCliAuthJson> {
  const file = path.join(hostAuthDir, 'auth.json');
  if (!fs.existsSync(file)) return null;
  try {
    return importCliAuthJson(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>);
  } catch {
    return null;
  }
}

export interface GrokAuthDeps {
  projectRoot?: string;
  /** Injected in tests; runs docker with inherited stdio in production. */
  runDocker?: (args: string[]) => void;
  log?: (message: string) => void;
}

/**
 * Device-code walk-through. Idempotent: re-running simply replaces the stored
 * credential, which is also how an expired or revoked session is recovered.
 */
export async function runGrokAuth(deps: GrokAuthDeps = {}): Promise<void> {
  const projectRoot = deps.projectRoot ?? process.cwd();
  const log = deps.log ?? ((m: string) => console.log(m));
  const image = getDefaultContainerImage(projectRoot);

  // A host temp dir, not the group's .grok-shared: the CLI writes a full
  // auth.json here INCLUDING the refresh token, and that file must never be
  // the one a container sees. It is imported, then removed.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-login-'));
  fs.chmodSync(dir, 0o700);

  try {
    log('Opening a device-code login. A URL and a short code will appear — confirm it on any device with a browser.');
    const run = deps.runDocker ?? ((args: string[]) => void execFileSync('docker', args, { stdio: 'inherit' }));
    run(buildDeviceLoginArgs(image, dir));

    const creds = importLoginResult(dir);
    if (!creds) {
      throw new Error(
        'Grok login did not produce a usable session. Re-run the auth step; if it keeps failing, check that the agent image carries the grok CLI.',
      );
    }

    writeSharedCredentials(creds);
    log(`Grok authenticated${creds.email ? ` as ${creds.email}` : ''}. The refresh token stays on the host; containers get a short-lived token only.`);
  } finally {
    // The temp copy holds a live refresh token — remove it whether or not the
    // login succeeded.
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Verify the payload is wired: files present, all three barrels importing. */
export async function checkGrokInstall(projectRoot: string = process.cwd()): Promise<void> {
  const missing = GROK_PAYLOAD_FILES.filter((f) => !fs.existsSync(path.join(projectRoot, f)));
  if (missing.length > 0) {
    throw new Error(`Grok payload incomplete — missing: ${missing.join(', ')}`);
  }
  const unwired = GROK_BARRELS.filter(({ file, needle }) => {
    const p = path.join(projectRoot, file);
    return !fs.existsSync(p) || !fs.readFileSync(p, 'utf8').includes(needle);
  }).map(({ file }) => file);
  if (unwired.length > 0) {
    throw new Error(`Grok is not registered in: ${unwired.join(', ')} — append the import line to each barrel`);
  }
}

registerSetupProvider({
  value: 'grok',
  label: 'Grok',
  hint: 'xAI subscription (SuperGrok / X Premium+) — device-code login, no API key',
  runAuth: () => runGrokAuth(),
  runInstallCheck: () => checkGrokInstall(),
});
