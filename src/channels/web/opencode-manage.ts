// ── OpenCode harness install (wizard) ───────────────────────────────────────
// Picking a local model in the wizard used to be a no-op on inference. The
// binding is in models.ts:
//
//   providerForModelKind(kind) → opencodeInstalled() ? 'opencode' : null
//   envForModel(model)         → model.kind !== 'anthropic' ? {} : { ANTHROPIC_MODEL }
//
// so without the OpenCode harness a local model produces NO env at all and the
// agent keeps running on Claude. The roster row is created, the default is set,
// containers restart — and every token still goes to Anthropic. It failed
// silently, and nothing in the UI mentioned OpenCode (zero matches across the
// whole client bundle).
//
// So the wizard installs it. The skill is upstream's `.claude/skills/add-opencode`,
// applied through upstream's own programmatic path (setup/providers/install.ts),
// which is the same call the terminal setup flow makes. Nothing here forks it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { log } from '../../log.js';
import { listProviderContainerConfigNames } from '../../providers/provider-container-registry.js';
import { writeUpgradeState } from '../../upgrade-state.js';
import { pnpmDir } from './host-path.js';
import { runInstallChain, scheduleHostRestart, type InstallState, type InstallStep } from './ollama-manage.js';

/** Where upstream ships the provider skill this installs. */
export const OPENCODE_SKILL_DIR = '.claude/skills/add-opencode';

export interface OpencodeState {
  /** The provider is registered — a local model has a harness to run on. */
  installed: boolean;
  /** This host can run the install now. */
  canInstall: boolean;
  /** Why not, when canInstall is false. Null when it can. */
  reason: string | null;
}

/**
 * Pure gating, so the branching is unit-tested without a filesystem or a docker
 * daemon. Order matters: "already installed" is not a failure, it is the
 * finished state, and reporting a reason for it would put an error in the UI
 * for the case that is working.
 */
export function opencodeInstallability(facts: {
  installed: boolean;
  skillPresent: boolean;
  dockerAvailable: boolean;
  pnpmFound: boolean;
}): { canInstall: boolean; reason: string | null } {
  if (facts.installed) return { canInstall: false, reason: null };
  if (!facts.skillPresent)
    return {
      canInstall: false,
      reason: `${OPENCODE_SKILL_DIR} is not in this checkout — update to a build that ships it.`,
    };
  // container/build.sh rebuilds the agent image, which is the step a local
  // model actually needs: the new provider lives INSIDE the container.
  if (!facts.dockerAvailable)
    return {
      canInstall: false,
      reason: 'Docker is not reachable — the agent image has to be rebuilt to carry the harness.',
    };
  // Checked HERE, before the button is offered, rather than discovered by the
  // first step: three of the five steps shell out to pnpm, and the skill apply
  // is the first of them. Failing on it later would be a half-applied provider.
  if (!facts.pnpmFound)
    return { canInstall: false, reason: 'pnpm is not on this service’s PATH — the rebuild steps need it.' };
  return { canInstall: true, reason: null };
}

// `docker info` is a round trip against the daemon, and this state is read by
// the onboarding endpoint AND by a 2-second progress poll for the length of an
// image build. Probing per call would spawn a process every two seconds for
// several minutes. Cached: a daemon that appears mid-install is picked up
// within the TTL, which is far sooner than anyone can act on it.
const DOCKER_PROBE_TTL_MS = 30_000;
let dockerProbe: { at: number; ok: boolean } | null = null;

function dockerAvailable(): boolean {
  if (dockerProbe && Date.now() - dockerProbe.at < DOCKER_PROBE_TTL_MS) return dockerProbe.ok;
  let ok = false;
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 });
    ok = true;
  } catch {
    ok = false;
  }
  dockerProbe = { at: Date.now(), ok };
  return ok;
}

export function _resetDockerProbeForTest(): void {
  dockerProbe = null;
}

export function getOpencodeState(root: string = process.cwd()): OpencodeState {
  const installed = listProviderContainerConfigNames().includes('opencode');
  // Skip the docker probe once it is installed — nothing is going to be built,
  // and `docker info` is a round trip on every onboarding poll.
  const facts = {
    installed,
    skillPresent: fs.existsSync(path.join(root, OPENCODE_SKILL_DIR, 'SKILL.md')),
    dockerAvailable: installed ? true : dockerAvailable(),
    pnpmFound: installed ? true : pnpmDir() !== null,
  };
  return { installed, ...opencodeInstallability(facts) };
}

const opencodeInstallState: InstallState = {
  running: false,
  lines: [],
  exitCode: null,
  startedAt: null,
  finishedAt: null,
  stepIndex: 0,
  stepCount: 0,
  stepLabel: null,
};

export function getOpencodeInstallState(root: string = process.cwd()): InstallState & OpencodeState {
  return { ...opencodeInstallState, ...getOpencodeState(root) };
}

/**
 * The chain succeeded, but THIS process still reports the provider as absent.
 *
 * opencodeInstalled() reads the in-memory provider registry, populated when
 * dist/providers/index.js was imported — before the skill was applied. So the
 * process that runs the install can never see the result of it, no matter what
 * is on disk. And the last step only SCHEDULES the restart (detached, after a
 * 2s sleep), so the chain reports complete while the process that reported it
 * is still the old one.
 *
 * Every field this reads is already in the state; the client just had no way to
 * tell "finished, not installed" (a failure) from "finished, restart coming"
 * (a success it cannot see yet). Without it the row fell back to "needs
 * OpenCode" with an Install button, and pressing that button did nothing but
 * ask the NEW process — which answered "already installed" and made the row
 * finally correct. That is the loop the operator was stuck in.
 */
export function restartPending(
  state: Pick<InstallState, 'running' | 'exitCode' | 'finishedAt'> & { installed: boolean },
): boolean {
  return !state.running && !state.installed && state.exitCode === 0 && state.finishedAt !== null;
}

export function _resetOpencodeInstallForTest(): void {
  Object.assign(opencodeInstallState, {
    running: false,
    lines: [],
    exitCode: null,
    startedAt: null,
    finishedAt: null,
    stepIndex: 0,
    stepCount: 0,
    stepLabel: null,
  });
}

/**
 * The chain, and why each step is in it.
 *
 * Exported and pure-ish so the ORDER is asserted in tests: this is self-surgery
 * — the install rebuilds and restarts the very process running it — and the two
 * steps easiest to forget are the ones that decide whether it comes back up.
 */
export function opencodeInstallSteps(root: string): InstallStep[] {
  return [
    // Upstream's own apply path (setup/providers/install.ts), reached through a
    // subprocess rather than an import: the host build is rooted at src/, so
    // src/ cannot compile against setup/. The CLI exits non-zero when the apply
    // leaves anything non-deterministic behind, which fails the chain here.
    // That path's dependency resolver runs bun via `pnpm dlx` at the pinned
    // version when the host has none, so this needs nothing a nanoclaw host
    // does not already have.
    {
      run: ['pnpm', ['exec', 'tsx', 'scripts/install-provider.ts', OPENCODE_SKILL_DIR]],
      label: 'Applying the OpenCode skill',
    },
    // The host runs from dist/. The skill edited src/, so without this the new
    // provider exists on disk and is invisible to the process that restarts.
    { run: ['pnpm', ['run', 'build']], label: 'Rebuilding NanoClaw' },
    // And the agent-runner half lives inside the image.
    { run: ['bash', ['./container/build.sh', 'build']], label: 'Rebuilding the agent image' },
    {
      label: 'Stamping the upgrade marker',
      call: () => {
        // Applying a skill dirties the tree, and enforceUpgradeTripwire refuses
        // to start a host whose code identity doesn't match the marker. Without
        // this the restart below is a crash loop, and the operator is left with
        // a dead install and no idea that a wizard click did it.
        const stamped = writeUpgradeState({ via: 'web-opencode-install', projectRoot: root });
        log.info('Web: stamped upgrade marker after OpenCode install', { version: stamped.version });
      },
    },
    {
      label: 'Restarting',
      call: () => {
        // Detached transient unit — see providerRestartCommand for why a
        // service must not restart itself from inside its own cgroup.
        scheduleHostRestart();
      },
    },
  ];
}

export function startOpencodeInstall(root: string = process.cwd()): { started: boolean; error?: string } {
  if (opencodeInstallState.running) return { started: false, error: 'already-running' };
  const state = getOpencodeState(root);
  if (state.installed) return { started: false, error: 'already-installed' };
  if (!state.canInstall) return { started: false, error: state.reason ?? 'not-supported' };
  _resetOpencodeInstallForTest();
  opencodeInstallState.running = true;
  opencodeInstallState.startedAt = Date.now();
  runInstallChain(opencodeInstallState, opencodeInstallSteps(root), root);
  return { started: true };
}
