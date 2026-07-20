/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { OneCLI } from '@onecli-sh/sdk';

import {
  CONTAINER_CPU_LIMIT,
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CONTAINER_INSTALL_LABEL,
  CONTAINER_MEMORY_LIMIT,
  DATA_DIR,
  GROUPS_DIR,
  ONECLI_API_KEY,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { materializeContainerJson } from './container-config.js';
import { getContainerConfig } from './db/container-configs.js';
import { updateContainerConfigScalars, updateContainerConfigJson } from './db/container-configs.js';
import {
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  makeContainerWritable,
  readonlyMountArgs,
  resolveAgentIdentity,
  resolveContainerEnv,
  runSessionPrepareHooks,
  stopContainer,
} from './container-runtime.js';
import { EGRESS_NETWORK, egressNetworkArgs, ensureEgressNetwork } from './egress-lockdown.js';
import { EGRESS_LOCKDOWN } from './config.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { initGroupFilesystem } from './group-init.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { notifySessionStopped } from './modules/agent-status/index.js';
import { log } from './log.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  providerProvidesAgentSurfaces,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import {
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  sessionDir,
  writeSessionRouting,
  writeOutboundDirect,
} from './session-manager.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import type { AgentGroup, Session } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

/** Active containers tracked by session ID. */
const activeContainers = new Map<string, { process: ChildProcess; containerName: string }>();

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
const wakePromises = new Map<string, Promise<boolean>>();

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * The container runs the v2 agent-runner which polls the session DB.
 *
 * Contract: never throws. Returns `true` on successful spawn, `false` on
 * transient spawn failure (e.g. OneCLI gateway unreachable). Callers don't
 * need to wrap — the inbound row stays pending and host-sweep retries on
 * its next tick. Callers that care (e.g. the router's typing indicator)
 * can branch on the boolean.
 */
export function wakeContainer(session: Session): Promise<boolean> {
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve(true);
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  const promise = spawnContainer(session)
    .then(() => {
      spawnFailures.delete(session.id); // recovered — reset the streak + re-arm the notice
      return true;
    })
    .catch((err) => {
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
      noteSpawnFailure(session);
      return false;
    })
    .finally(() => {
      wakePromises.delete(session.id);
    });
  wakePromises.set(session.id, promise);
  return promise;
}

/**
 * Consecutive spawn-failure count per session. A spawn failing once is normal
 * (transient gateway blip, host-sweep retries); failing repeatedly means the
 * agent genuinely can't start — almost always the OneCLI credential gateway
 * being unreachable/misconfigured. Without this, host-sweep retries forever and
 * the room just looks dead, which is the single worst OneCLI failure mode.
 */
const spawnFailures = new Map<string, number>();
const SPAWN_FAILURE_NOTICE_AT = 3;

/**
 * Record a failed spawn for a session; once it crosses the threshold, post ONE
 * persistent notice into the room so the silence is explained and an admin
 * knows to look. Reset on the next successful spawn (re-arms the notice for a
 * future outage). Best-effort — never throws into the wake path.
 */
function noteSpawnFailure(session: Session): void {
  const n = (spawnFailures.get(session.id) ?? 0) + 1;
  spawnFailures.set(session.id, n);
  if (n !== SPAWN_FAILURE_NOTICE_AT) return; // fire exactly once per outage
  try {
    const mg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
    if (!mg || !mg.platform_id) return; // nowhere to post (e.g. agent-only session)
    writeOutboundDirect(session.agent_group_id, session.id, {
      id: `spawn-fail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      platformId: mg.platform_id,
      channelType: mg.channel_type,
      threadId: session.thread_id ?? null,
      content: JSON.stringify({
        text:
          "⚠️ I couldn't start to handle that — this usually means the credential gateway (OneCLI) is " +
          'unreachable or misconfigured. An admin may need to check it; I’ll keep retrying and reply once it’s back.',
      }),
    });
    log.warn('Posted spawn-failure notice to room after repeated failures', {
      sessionId: session.id,
      failures: n,
    });
  } catch (err) {
    log.warn('Failed to post spawn-failure notice', { sessionId: session.id, err });
  }
}

async function spawnContainer(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }

  // Refresh the destination map and current-thread routing so any admin
  // changes take effect on wake. Destinations come from the agent-to-agent
  // module — skip when the module isn't installed (table absent).
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  // Materialize container.json from DB — writes fresh file and returns
  // the config object, threaded through provider resolution, buildMounts,
  // and buildContainerArgs so we don't re-read.
  const containerConfig = materializeContainerJson(agentGroup.id);

  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before. Runs before the provider
  // contribution so a surfaces-providing provider finds the group dir ready.
  const providerName = resolveProviderName(session.agent_provider, containerConfig.provider);
  initGroupFilesystem(agentGroup, { provider: providerName });

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = resolveProviderContribution(session, agentGroup, containerConfig);

  const mounts = buildMounts(agentGroup, session, containerConfig, provider, contribution);
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  // Run any module pre-spawn hooks BEFORE resolving identity/env. UserCreds uses this
  // for lazy enrollment: a connected member's first use of a room creates the
  // per-member OneCLI agent here, so resolveAgentIdentity below finds it ready.
  await runSessionPrepareHooks(agentGroup.id, session.thread_id);
  // OneCLI agent identifier defaults to the agent group id (stable, reversible
  // via getAgentGroup() for approval routing). An installed module (UserCreds) may
  // override it for a per-member session so the container spawns under the
  // member's own OneCLI agent (their key); approval routing then reverses it
  // via the user_credential_members map.
  const agentIdentifier = resolveAgentIdentity(agentGroup.id, session.thread_id) ?? agentGroup.id;
  // Module-contributed env for this session (UserCreds OAuth injects a sentinel
  // CLAUDE_CODE_OAUTH_TOKEN to flip Claude Code into OAuth mode; OneCLI swaps the
  // real token on the wire). Empty for normal sessions.
  const extraEnv = resolveContainerEnv(agentGroup.id, session.thread_id);
  const args = await buildContainerArgs(
    mounts,
    containerName,
    agentGroup,
    containerConfig,
    provider,
    contribution,
    agentIdentifier,
    extraEnv,
  );

  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  // Clear any orphan heartbeat from a previous container instance — the
  // sweep's ceiling check treats a missing file as "fresh spawn, give grace"
  // (host-sweep.ts line 87). Without this, the stale mtime can trigger an
  // immediate kill before the new container touches the file itself.
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  activeContainers.set(session.id, { process: container, containerName });
  markContainerRunning(session.id);

  // Log stderr. A container that dies at boot (unknown provider, missing
  // binary, bad config) explains itself only here — and debug is below the
  // default log level — so keep a tail to surface on a non-zero exit.
  const stderrTail: string[] = [];
  container.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (!line) continue;
      log.debug(line, { container: agentGroup.folder });
      stderrTail.push(line);
      if (stderrTail.length > 10) stderrTail.shift();
    }
  });

  // stdout is unused in v2 (all IO is via session DB)
  container.stdout?.on('data', () => {});

  // No host-side idle timeout. Stale/stuck detection is driven by the host
  // sweep reading heartbeat mtime + processing_ack claim age + container_state
  // (see src/host-sweep.ts). This avoids killing long-running legitimate work
  // on a wall-clock timer.

  container.on('close', (code) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    // If a turn was still in progress, tell the room the agent stopped instead
    // of letting the thinking bubble vanish silently (no-op on a clean exit).
    void notifySessionStopped(session);
    // code null = killed by signal (normal shutdown path), not a boot failure.
    if (code !== 0 && code !== null && stderrTail.length > 0) {
      log.warn('Container exited non-zero', { sessionId: session.id, code, containerName, stderrTail });
    } else {
      log.info('Container exited', { sessionId: session.id, code, containerName });
    }
  });

  container.on('error', (err) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    void notifySessionStopped(session);
    log.error('Container spawn error', { sessionId: session.id, err });
  });
}

/** Kill a container for a session. */
export function killContainer(sessionId: string, reason: string, onExit?: () => void): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  if (onExit) {
    entry.process.once('close', onExit);
  }

  log.info('Killing container', { sessionId, reason, containerName: entry.containerName });
  try {
    stopContainer(entry.containerName);
  } catch {
    entry.process.kill('SIGKILL');
  }
}

/**
 * Resolve the provider name for a session:
 *
 *   sessions.agent_provider
 *     → container_configs.provider
 *     → 'claude'
 *
 * Pure so the precedence can be unit-tested without a DB or filesystem.
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
): string {
  return (sessionProvider || containerConfigProvider || 'claude').toLowerCase();
}

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): { provider: string; contribution: ProviderContainerContribution } {
  const provider = resolveProviderName(session.agent_provider, containerConfig.provider);
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        groupDir: path.resolve(GROUPS_DIR, agentGroup.folder),
        selectedSkills: selectedSkillNames(containerConfig),
        hostEnv: process.env,
      })
    : {};
  return { provider, contribution };
}

export function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: import('./container-config.js').ContainerConfig,
  provider: string,
  providerContribution: ProviderContainerContribution,
): VolumeMount[] {
  const projectRoot = process.cwd();

  // Default agent surfaces (composed project doc, skill links, provider state
  // dir) apply unless the provider's registration declares it provides its
  // own — a capability, never a provider name. See provider-container-registry.
  const defaultSurfaces = !providerProvidesAgentSurfaces(provider);

  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  if (defaultSurfaces) {
    // Sync skill symlinks based on container.json selection before mounting.
    syncSkillSymlinks(claudeDir, containerConfig);

    // Compose CLAUDE.md fresh every spawn from the shared base, enabled skill
    // fragments, and MCP server instructions. See `claude-md-compose.ts`.
    composeGroupClaudeMd(agentGroup);
  }

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/)
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });

  // Agent group folder at /workspace/agent (RW for working files + shared memory)
  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

  // container.json — nested RO mount on top of RW group dir so the agent
  // can read its config but cannot modify it.
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    mounts.push({ hostPath: containerJsonPath, containerPath: '/workspace/agent/container.json', readonly: true });
  }

  // Composer-managed CLAUDE.md artifacts — nested RO mounts. These are
  // regenerated from the shared base + fragments on every spawn; any
  // agent-side writes would be clobbered, so enforce read-only. The shared
  // memory tree and standing-instructions source remain RW via the group mount.
  // `.claude-shared.md` is a symlink whose target (`/app/CLAUDE.md`) is
  // already RO-mounted, so writes through it fail regardless — no need for
  // a nested mount there.
  const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (defaultSurfaces && fs.existsSync(composedClaudeMd)) {
    mounts.push({ hostPath: composedClaudeMd, containerPath: '/workspace/agent/CLAUDE.md', readonly: true });
  }
  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (defaultSurfaces && fs.existsSync(fragmentsDir)) {
    mounts.push({ hostPath: fragmentsDir, containerPath: '/workspace/agent/.claude-fragments', readonly: true });
  }

  // Shared CLAUDE.md — read-only, imported by the composed entry point via
  // the `.claude-shared.md` symlink inside the group dir.
  const sharedClaudeMd = path.join(process.cwd(), 'container', 'CLAUDE.md');
  if (defaultSurfaces && fs.existsSync(sharedClaudeMd)) {
    mounts.push({ hostPath: sharedClaudeMd, containerPath: '/app/CLAUDE.md', readonly: true });
  }

  // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
  // skill symlinks)
  if (defaultSurfaces) {
    // On a root host this dir is created root:root, but it's mounted RW into a
    // UID-1000 container which must write /home/node/.claude/settings.json —
    // otherwise the agent-runner dies with EACCES. Chown it to the container UID
    // (no-op off-root), closing the gap left by the group/session-dir chowns.
    fs.mkdirSync(claudeDir, { recursive: true });
    makeContainerWritable(claudeDir, true);
    mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });
  }

  // Shared agent-runner source — read-only, same code for all groups.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });

  // Shared skills — read-only, symlinks in .claude-shared/skills/ point here.
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    mounts.push({ hostPath: skillsSrc, containerPath: '/app/skills', readonly: true });
  }
  // User-added skills (imported/uploaded at runtime) — a separate read-only
  // mount so they never mix into the version-controlled container/skills. The
  // dir is created on demand; a skill's symlink resolves to whichever mount
  // holds it (see skillContainerPath).
  const userSkillsSrc = path.join(projectRoot, 'data', 'user-skills');
  try {
    fs.mkdirSync(userSkillsSrc, { recursive: true });
  } catch {
    /* best-effort */
  }
  if (fs.existsSync(userSkillsSrc)) {
    mounts.push({ hostPath: userSkillsSrc, containerPath: '/app/user-skills', readonly: true });
  }

  // Additional mounts from container config
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated);
  }

  // Provider-contributed mounts (e.g. a provider's XDG data dir)
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  return mounts;
}

/**
 * Sync skill symlinks in .claude-shared/skills/ to match the container.json
 * selection. Each symlink points to a container path (/app/skills/<name>)
 * so it's dangling on the host but valid inside the container.
 */
function syncSkillSymlinks(claudeDir: string, containerConfig: import('./container-config.js').ContainerConfig): void {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  const desired = selectedSkillNames(containerConfig);
  const desiredSet = new Set(desired);

  // Remove symlinks not in the desired set
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    // Unlink when deselected OR when the skill no longer exists in any mount —
    // a deleted-but-still-selected skill would otherwise leave a dangling
    // symlink in .claude/skills (the create loop below can't repair a target
    // that resolves to nothing).
    if (isSymlink && (!desiredSet.has(entry) || !skillContainerTarget(entry))) {
      fs.unlinkSync(entryPath);
    }
  }

  // Create/repair symlinks for desired skills, each pointing at whichever mount
  // actually holds it (/app/skills for shipped, /app/user-skills for imported).
  for (const skill of desired) {
    const target = skillContainerTarget(skill);
    if (!target) continue; // skill no longer exists in either source — skip
    const linkPath = path.join(skillsDir, skill);
    let current: string | null = null;
    let isRealEntry = false;
    try {
      const st = fs.lstatSync(linkPath);
      if (st.isSymbolicLink()) {
        current = fs.readlinkSync(linkPath);
      } else {
        // A real entry here is either a template overlay (intentional; see
        // src/group-skills.ts) or a stale pre-refactor skill copy that shadows
        // the shared skill (#3001). No marker distinguishes them yet, so
        // surface the skip instead of staying silent — and never delete it.
        current = '';
        isRealEntry = true;
      }
    } catch {
      current = null; // no entry
    }
    if (current === target) continue; // already correct
    if (isRealEntry) {
      log.warn(
        'Skill not symlinked: real entry occupies the path (template overlay or stale pre-refactor copy)',
        { skill, path: linkPath },
      );
      continue;
    }
    try {
      if (current !== null) fs.unlinkSync(linkPath);
    } catch {
      /* ignore */
    }
    fs.symlinkSync(target, linkPath);
  }
}

// The container path for a skill, chosen by which host mount holds it. Shipped
// skills win over user skills of the same name (a user can't shadow a builtin).
function skillContainerTarget(name: string): string | null {
  if (fs.existsSync(path.join(process.cwd(), 'container', 'skills', name))) return `/app/skills/${name}`;
  if (fs.existsSync(path.join(process.cwd(), 'data', 'user-skills', name))) return `/app/user-skills/${name}`;
  return null;
}

// Every skill directory across both mounts (shipped + user), deduped.
function availableSkillNames(): string[] {
  const dirs = [path.join(process.cwd(), 'container', 'skills'), path.join(process.cwd(), 'data', 'user-skills')];
  const names = new Set<string>();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir)) {
      try {
        if (fs.statSync(path.join(dir, e)).isDirectory()) names.add(e);
      } catch {
        /* skip unreadable */
      }
    }
  }
  return [...names];
}

/**
 * Resolve the group's skill selection to concrete names — `'all'` recomputes
 * from both skill mounts so newly-added (shipped or imported) skills appear
 * automatically.
 */
function selectedSkillNames(containerConfig: import('./container-config.js').ContainerConfig): string[] {
  if (containerConfig.skills !== 'all') return containerConfig.skills;
  return availableSkillNames();
}

/**
 * Output-token ceiling for the Claude agent SDK.
 *
 * Left unset, the SDK caps a turn at 32000 output tokens and kills it with
 * "Claude's response exceeded the 32000 output token maximum" — which killed real
 * turns (a long CAD/OpenSCAD answer in rolling-bench). Every current model's real
 * ceiling is far higher, so there's no reason to leave that headroom unused.
 *
 * Model-aware because the ceilings differ and overshooting is a 400:
 *   Haiku 4.5                                    →  64K
 *   Opus 4.6/4.7/4.8, Sonnet 4.6/5, Fable 5      → 128K
 *
 * Unknown/custom model strings fall back to 64K — the value every current model
 * accepts. Override with NANOCLAW_MAX_OUTPUT_TOKENS. This is a ceiling, not a
 * target: raising it costs nothing unless a turn actually needs the room.
 */
function maxOutputTokensFor(model: string | null | undefined): number {
  const override = Number(process.env.NANOCLAW_MAX_OUTPUT_TOKENS);
  if (Number.isFinite(override) && override > 0) return Math.floor(override);
  const m = (model ?? '').toLowerCase();
  if (m.includes('haiku')) return 64_000;
  if (!m || m.includes('opus') || m.includes('sonnet') || m.includes('fable')) return 128_000;
  return 64_000;
}

/**
 * Container hardening flags (security model §container-isolation). Always on
 * unless NANOCLAW_CONTAINER_NO_HARDEN=1 (the escape hatch for a workload a
 * dropped capability genuinely breaks — report it, don't live there).
 *
 * The image runs as `node` under tini and never escalates, so the drop-ALL
 * baseline needs only the file-ownership caps package managers and unzip-ish
 * tools use. no-new-privileges blocks setuid escalation outright; pids-limit
 * turns a fork bomb into a contained failure (default 512, override via
 * NANOCLAW_CONTAINER_PIDS_LIMIT).
 */
export function containerHardeningArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NANOCLAW_CONTAINER_NO_HARDEN === '1') return [];
  const pids = env.NANOCLAW_CONTAINER_PIDS_LIMIT || '512';
  return [
    '--cap-drop',
    'ALL',
    '--cap-add',
    'CHOWN',
    '--cap-add',
    'DAC_OVERRIDE',
    '--cap-add',
    'FOWNER',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    pids,
  ];
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  provider: string,
  providerContribution: ProviderContainerContribution,
  agentIdentifier?: string,
  extraEnv?: Record<string, string>,
): Promise<string[]> {
  const args: string[] = ['run', '--rm', '--name', containerName, '--label', CONTAINER_INSTALL_LABEL];

  // Per-container resource caps. Memory now DEFAULTS to a hard 8g cap — a
  // runaway agent has OOM-killed real installs (the a2a flood) and an
  // unbounded default privileges the failure case. CONTAINER_MEMORY_LIMIT
  // overrides; the literal "none" restores unbounded. CPU stays opt-in
  // (contention degrades, it doesn't take the host down).
  if (CONTAINER_CPU_LIMIT) args.push('--cpus', CONTAINER_CPU_LIMIT);
  const memLimit = CONTAINER_MEMORY_LIMIT || '8g';
  if (memLimit !== 'none') args.push('--memory', memLimit);
  args.push(...containerHardeningArgs());

  // Environment — only vars read by code we don't own.
  // Everything NanoClaw-specific is in container.json (read by runner at startup).
  args.push('-e', `TZ=${TIMEZONE}`);

  // Raise the SDK's 32000 output-token cap to the model's real ceiling. Claude
  // provider only — the var is read by the Claude Agent SDK and means nothing to
  // other providers (e.g. codex/ollama), whose own limits are configured elsewhere.
  if (provider === 'claude') {
    args.push('-e', `CLAUDE_CODE_MAX_OUTPUT_TOKENS=${maxOutputTokensFor(containerConfig.model)}`);
  }

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, NO_PROXY).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Egress policy — most restrictive wins:
  //   config.egress 'none'       → no network at all (fully local agents);
  //   config.egress 'host-only'  → the install-wide lockdown mechanism,
  //                                forced for THIS group (internal network,
  //                                gateway aliased in, fail-fast contract);
  //   NANOCLAW_EGRESS_LOCKDOWN   → same mechanism for every group;
  //   otherwise                  → open egress via the host gateway.
  if (containerConfig.egress === 'none') {
    args.push('--network', 'none');
    log.info('Egress: none (per-group)', { containerName });
  } else if (ensureEgressNetwork(containerConfig.egress === 'host-only')) {
    args.push(...egressNetworkArgs());
    log.info('Egress lockdown active', {
      containerName,
      network: EGRESS_NETWORK,
      scope: EGRESS_LOCKDOWN ? 'install-wide' : 'per-group',
    });
  } else {
    args.push(...hostGatewayArgs());
  }

  // User mapping
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Volume mounts
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // OneCLI gateway — injects HTTPS_PROXY + certs so container API calls
  // are routed through the agent vault for credential injection, and mounts
  // any credential stubs the gateway serves (e.g. a sentinel auth file).
  // Runs AFTER the volume mounts so a stub nested inside one of our mounts
  // (a parent dir mounted RW above it) lands later in the args and isn't
  // shadowed by it. Treated as a transient hard failure: if we can't wire
  // the gateway, we don't spawn. The caller (router or host-sweep) catches
  // the throw, leaves the inbound message pending, and the next sweep tick
  // retries.
  if (agentIdentifier) {
    await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
  }
  const onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
  if (!onecliApplied) {
    throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
  }
  log.info('OneCLI gateway applied', { containerName });

  // Module-contributed env (UserCreds OAuth: a sentinel CLAUDE_CODE_OAUTH_TOKEN).
  // Applied AFTER the OneCLI gateway so it wins on key collisions (last `-e`
  // wins). Anthropic still routes through OneCLI, which swaps the sentinel bearer
  // for the member's real vault token on the wire.
  if (extraEnv) {
    for (const [key, value] of Object.entries(extraEnv)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Override entrypoint: run v2 entry point directly via Bun (no tsc, no stdin).
  args.push('--entrypoint', 'bash');

  // Use per-agent-group image if one has been built, otherwise base image
  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  args.push('-c', 'exec bun run /app/src/index.ts');

  return args;
}

const execAsync = promisify(exec);

/** Build a per-agent-group Docker image with custom packages. */
export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const configRow = getContainerConfig(agentGroup.id);
  if (!configRow) throw new Error('Container config not found');
  const aptPackages = JSON.parse(configRow.packages_apt) as string[];
  const npmPackages = JSON.parse(configRow.packages_npm) as string[];
  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  let dockerfile = `FROM ${CONTAINER_IMAGE}\nUSER root\n`;
  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npmPackages.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = npmPackages.map((p) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`).join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  dockerfile += 'USER node\n';

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  // Write Dockerfile to temp file and build
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    // Awaited async exec so the single-threaded host stays responsive during
    // the build (can take minutes) instead of blocking on execSync. exec buffers
    // stdout/stderr (matching the old stdio: 'pipe') and rejects on a non-zero
    // exit, so error propagation is unchanged.
    await execAsync(`${CONTAINER_RUNTIME_BIN} build -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      timeout: 900_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  // Store the image tag in the DB
  updateContainerConfigScalars(agentGroup.id, { image_tag: imageTag });

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
