/**
 * Host-side container config for the `codex` provider.
 *
 * Registers with `providesAgentSurfaces` — codex owns its agent-facing
 * surfaces, so core skips the default (Claude) compose/mounts and this
 * contribution supplies them instead:
 *
 *   - AGENTS.md — codex's project doc, composed fresh every spawn
 *     (see ./codex-agents-md.ts), mounted RO over the RW group dir.
 *   - .agents/skills — codex-native skill links synced to the group's
 *     container.json selection, mounted RO.
 *   - ~/.codex — a per-GROUP private state dir (`.codex-shared`), persistent
 *     across sessions so thread metadata and config.toml survive respawns.
 *
 * Credentials: NONE here — v2's invariant is that containers never receive
 * raw API keys; OneCLI is the sole credential path. The OpenAI key (or
 * ChatGPT token) lives in the OneCLI vault with an api.openai.com /
 * chatgpt.com host pattern; codex's traffic already rides the gateway proxy
 * (every spawn applies it — see container-runner.ts), which injects the real
 * credential in flight. The container only ever sees the `onecli-managed`
 * placeholder. Model/effort come from container_config (`ncl groups config
 * update --model/--effort`), not env.
 *
 * Memory and exchange archiving are NOT handled here either. The shared
 * runner scaffolds memory, while the container-side provider registers its
 * native SessionStart hook and persists exchanges through
 * `onExchangeComplete`.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { materializeTemplateSkills } from '../group-skills.js';
import { composeGroupAgentsMd } from './codex-agents-md.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

// UID the agent container runs as (Dockerfile `USER node`); override for a
// non-standard image. Mirrors container-runtime's root-host mount handling.
const CONTAINER_UID = Number(process.env.NANOCLAW_CONTAINER_UID ?? 1000);

/**
 * On a root host (community-scripts systemd unit) dirs this provider creates
 * are root:root, but they're mounted RW into the UID-1000 container, which
 * must write ~/.codex/config.toml — otherwise codex dies with EACCES on its
 * first turn. Chown the tree to the container UID; no-op unless the host is
 * root. Kept local (not imported from container-runtime) so this payload file
 * compiles standalone on the providers-codex branch and on any tree it's
 * copied into.
 */
function chownTreeToContainerUid(target: string): void {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  // SECURITY: ~/.codex is bind-mounted RW into the container, so the agent can
  // plant symlinks in it. NEVER follow one — `fs.chownSync` dereferences, so a
  // `ln -s / config.d` would turn the next root spawn into `chown -R 1000 /`.
  // Use `fs.lchownSync` (chowns the link itself) and never recurse into a
  // non-directory, so the walk can't leave the target tree.
  const walk = (p: string, dirent?: fs.Dirent): void => {
    try {
      fs.lchownSync(p, CONTAINER_UID, CONTAINER_UID);
    } catch {
      return; // unreadable/gone — nothing more to do down this path
    }
    let isDir: boolean;
    try {
      isDir = dirent ? dirent.isDirectory() : fs.lstatSync(p).isDirectory();
    } catch {
      return;
    }
    if (!isDir) return; // symlink or file — chowned above, never traversed
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) walk(path.join(p, e.name), e);
  };
  walk(target);
}

registerProviderContainerConfig(
  'codex',
  async (ctx) => {
    // Per-group codex state (config.toml, thread metadata).
    const codexDir = path.join(DATA_DIR, 'v2-sessions', ctx.agentGroupId, '.codex-shared');
    fs.mkdirSync(codexDir, { recursive: true });
    // OneCLI bind-mounts its auth stub at ~/.codex/auth.json, nested inside
    // this dir mount — Docker on macOS can't create a missing mountpoint file
    // inside a virtiofs bind mount (runc: "mountpoint is outside of rootfs",
    // exit 125), so it must exist before first spawn. Re-created here per
    // spawn because a group reset that wipes .codex-shared re-triggers it.
    // The 'a' flag creates the file if missing, never truncates an existing one.
    fs.closeSync(fs.openSync(path.join(codexDir, 'auth.json'), 'a'));
    // Root-host installs: make the RW ~/.codex mount writable by the
    // container user (see chownTreeToContainerUid).
    chownTreeToContainerUid(codexDir);

    // Compose this group's AGENTS.md and sync codex-native skill links.
    const group = await getAgentGroup(ctx.agentGroupId);
    if (group) await composeGroupAgentsMd(group, ctx.groupDir);
    syncCodexSkillLinks(ctx.groupDir, ctx.selectedSkills);
    // Template skills live on the Claude plane (.claude-shared/skills); codex
    // reads .agents/skills (RO-mounted), so mirror them here, host-side, via the
    // shared provider-agnostic helper. Real dirs survive the symlink-only prune
    // above and coexist with the shared-skill symlinks it creates.
    materializeTemplateSkills(ctx.agentGroupId, path.join(ctx.groupDir, '.agents', 'skills'));

    // No credential env here — OneCLI's container-config drives auth end to
    // end: the gateway serves a sentinel auth.json stub into ~/.codex for
    // BOTH auth modes (ChatGPT subscription and API key) and swaps the real
    // credential on the wire. Note the runner's CODEX_ENV_ALLOWLIST
    // deliberately strips OPENAI_API_KEY from the codex process env — auth
    // never rides env vars, only the stub. Duplicating any of it here would
    // be a second source of truth.
    const mounts = [{ hostPath: codexDir, containerPath: '/home/node/.codex', readonly: false }];
    const composedAgentsMd = path.join(ctx.groupDir, 'AGENTS.md');
    if (fs.existsSync(composedAgentsMd)) {
      // RO over the RW group dir — regenerated every spawn, agent edits would
      // be clobbered anyway. Memory behavior is edited via memory/system/.
      mounts.push({ hostPath: composedAgentsMd, containerPath: '/workspace/agent/AGENTS.md', readonly: true });
    }
    const agentsDir = path.join(ctx.groupDir, '.agents');
    if (fs.existsSync(agentsDir)) {
      mounts.push({ hostPath: agentsDir, containerPath: '/workspace/agent/.agents', readonly: true });
      // Codex only scans the CWD-level `.agents/skills` when the CWD is inside a
      // git repo; the agent workspace (/workspace/agent) is not one, so skills
      // materialized there are invisible. Codex DOES scan the user-level
      // `$HOME/.agents/skills` unconditionally, so mount the same dir at $HOME
      // to make the group's template + shared skills discoverable. Verified
      // against codex-cli 0.141: user-level `.agents/skills` resolves at a
      // non-git CWD. Skill materialization stays provider-neutral (group-skills.ts).
      mounts.push({ hostPath: agentsDir, containerPath: '/home/node/.agents', readonly: true });
    }

    return { mounts };
  },
  { providesAgentSurfaces: true },
);

/**
 * Sync `.agents/skills/<name>` symlinks to the selected skill set. Targets are
 * container paths (`/app/skills/<name>`) — dangling on the host, valid inside.
 */
function syncCodexSkillLinks(groupDir: string, selectedSkills: string[]): void {
  const skillsDir = path.join(groupDir, '.agents', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  const desired = new Set(selectedSkills);
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !desired.has(entry)) fs.unlinkSync(entryPath);
  }

  for (const skill of selectedSkills) {
    const linkPath = path.join(skillsDir, skill);
    try {
      fs.lstatSync(linkPath);
    } catch {
      fs.symlinkSync(`/app/skills/${skill}`, linkPath);
    }
  }
}
