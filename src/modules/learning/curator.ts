/**
 * The curator sweep (docs/design/learning-loop.md §6).
 *
 * A skill library that only ever grows rots: skills for tools that changed,
 * lessons for projects that ended. Hermes solves this with a curator; ours rides
 * nanoclaw's host sweep instead of their idle-at-startup trigger.
 *
 * What it does — and deliberately does NOT do:
 *   - marks a SCOPED skill stale when nothing has invoked it for
 *     NANOCLAW_CURATOR_ARCHIVE_DAYS (default 90) and moves it to the agent's
 *     `.archive/` dir. The agent stops seeing it; the operator can restore it
 *     from room settings. NOTHING IS EVER DELETED.
 *   - pooled/shared skills are untouched — those are operator-managed imports,
 *     not learning-loop output, and archiving something the operator installed
 *     on purpose is not "curation".
 *
 * Age comes from last-invoked telemetry: the agent-runner stamps
 * `.last-invoked` inside the skill dir whenever the SDK's Skill tool loads it.
 * A skill that has never been invoked ages from its SKILL.md mtime (= when it
 * was kept or last revised — a revision resets the clock, which is right: an
 * updated skill is a used skill).
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { log } from '../../log.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Directory name inside a scoped-skills dir. Dot-prefixed: skill scanners skip it. */
export const ARCHIVE_DIR = '.archive';

function archiveAfterDays(): number {
  const n = Number(process.env.NANOCLAW_CURATOR_ARCHIVE_DAYS ?? 90);
  return Number.isFinite(n) ? n : 90;
}

export interface ScopedSkillAge {
  name: string;
  /** ms epoch of the most recent signal: invocation, keep, or revision. */
  lastUsedAt: number;
}

/**
 * The decision, pure: which skills are stale at `now` given the threshold.
 * Never returns anything younger than the threshold, and a threshold ≤ 0 turns
 * the curator off entirely.
 */
export function decideStale(skills: ScopedSkillAge[], now: number, maxAgeDays: number): string[] {
  if (maxAgeDays <= 0) return [];
  const cutoff = now - maxAgeDays * DAY_MS;
  return skills.filter((s) => s.lastUsedAt < cutoff).map((s) => s.name);
}

/** Most recent of `.last-invoked` (stamped by the agent-runner) and SKILL.md mtime. */
export function skillLastUsedAt(skillDir: string): number | null {
  let t = 0;
  try {
    t = fs.statSync(path.join(skillDir, 'SKILL.md')).mtimeMs;
  } catch {
    return null; // not a skill
  }
  try {
    const stamp = Date.parse(fs.readFileSync(path.join(skillDir, '.last-invoked'), 'utf8').trim());
    if (Number.isFinite(stamp)) t = Math.max(t, stamp);
  } catch {
    /* never invoked — SKILL.md mtime stands */
  }
  return t;
}

/** Real skill dirs (scoped) in one agent's skills dir — symlinks are pooled, skip. */
function listScopedSkillDirs(skillsDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.'))
    .map((e) => e.name);
}

/** Archive one skill: move the dir under .archive/, never overwrite, never delete. */
function archiveSkill(skillsDir: string, name: string): void {
  const archiveRoot = path.join(skillsDir, ARCHIVE_DIR);
  fs.mkdirSync(archiveRoot, { recursive: true });
  let dest = path.join(archiveRoot, name);
  if (fs.existsSync(dest)) dest = `${dest}-${Date.now()}`; // an older archived copy exists — keep both
  fs.renameSync(path.join(skillsDir, name), dest);
}

// Daily gate, persisted so a restarting host doesn't re-walk every 60s tick.
const MARKER = path.join(DATA_DIR, 'learning', 'curator-last-run');
const RUN_EVERY_MS = DAY_MS;

function dueNow(): boolean {
  try {
    const last = Date.parse(fs.readFileSync(MARKER, 'utf8').trim());
    if (Number.isFinite(last) && Date.now() - last < RUN_EVERY_MS) return false;
  } catch {
    /* never ran */
  }
  return true;
}

function markRan(): void {
  fs.mkdirSync(path.dirname(MARKER), { recursive: true });
  fs.writeFileSync(MARKER, new Date().toISOString());
}

/**
 * The sweep entry point, called from the host sweep every tick and self-gated
 * to one real run per day. Walks every agent's scoped skills; archives the
 * stale ones. Idempotent and best-effort per agent — one unreadable dir never
 * stops the rest.
 */
export async function sweepStaleScopedSkills(): Promise<void> {
  const days = archiveAfterDays();
  if (days <= 0) return; // curator off
  if (!dueNow()) return;
  markRan();

  const sessionsRoot = path.join(DATA_DIR, 'v2-sessions');
  let groups: string[];
  try {
    groups = fs.readdirSync(sessionsRoot);
  } catch {
    return;
  }

  let archived = 0;
  for (const group of groups) {
    const skillsDir = path.join(sessionsRoot, group, '.claude-shared', 'skills');
    const ages: ScopedSkillAge[] = [];
    for (const name of listScopedSkillDirs(skillsDir)) {
      const t = skillLastUsedAt(path.join(skillsDir, name));
      if (t !== null) ages.push({ name, lastUsedAt: t });
    }
    for (const name of decideStale(ages, Date.now(), days)) {
      try {
        archiveSkill(skillsDir, name);
        archived++;
        log.info('Curator archived stale scoped skill', { group, skill: name, maxAgeDays: days });
      } catch (err) {
        log.error('Curator failed to archive skill', { group, skill: name, err });
      }
    }
  }
  if (archived > 0) log.info('Curator sweep done', { archived, maxAgeDays: days });
}

/** Archived skills for one agent (for the restore surface). `dataDir` is injectable for tests. */
export function listArchivedSkills(agentGroupId: string, dataDir: string = DATA_DIR): { name: string; archivedAt: number }[] {
  const root = path.join(dataDir, 'v2-sessions', agentGroupId, '.claude-shared', 'skills', ARCHIVE_DIR);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { name: string; archivedAt: number }[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      out.push({ name: e.name, archivedAt: fs.statSync(path.join(root, e.name)).mtimeMs });
    } catch {
      /* raced away */
    }
  }
  return out.sort((a, b) => b.archivedAt - a.archivedAt);
}

/**
 * Restore an archived skill. Refuses to clobber: if a live skill with that name
 * exists again (re-learned since archiving), the archive copy stays put.
 */
export function restoreArchivedSkill(
  agentGroupId: string,
  name: string,
  dataDir: string = DATA_DIR,
): { ok: boolean; error?: string } {
  const skillsDir = path.join(dataDir, 'v2-sessions', agentGroupId, '.claude-shared', 'skills');
  const src = path.join(skillsDir, ARCHIVE_DIR, name);
  const dest = path.join(skillsDir, name);
  if (!fs.existsSync(src)) return { ok: false, error: 'Not in the archive' };
  if (fs.existsSync(dest)) return { ok: false, error: 'A live skill with this name already exists' };
  // Restoring is a use signal — otherwise the next sweep re-archives it a day later.
  try {
    fs.writeFileSync(path.join(src, '.last-invoked'), new Date().toISOString());
  } catch {
    /* stamp is best-effort */
  }
  fs.renameSync(src, dest);
  return { ok: true };
}

/**
 * Scoped skills that exist under the SAME name on two or more agents. Each agent
 * learned it independently — the strongest signal a lesson belongs in the shared
 * pool rather than being re-learned per agent. Computed on demand; nothing is
 * stored. Promotion itself is a separate, owner-gated act.
 */
export function findDuplicateScopedSkills(
  dataDir: string = DATA_DIR,
): { name: string; agents: string[]; newestAgent: string }[] {
  const sessionsRoot = path.join(dataDir, 'v2-sessions');
  let groups: string[];
  try {
    groups = fs.readdirSync(sessionsRoot);
  } catch {
    return [];
  }
  const byName = new Map<string, { agent: string; mtime: number }[]>();
  for (const group of groups) {
    const skillsDir = path.join(sessionsRoot, group, '.claude-shared', 'skills');
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink() || e.name.startsWith('.')) continue;
      let mtime = 0;
      try {
        mtime = fs.statSync(path.join(skillsDir, e.name, 'SKILL.md')).mtimeMs;
      } catch {
        continue;
      }
      const list = byName.get(e.name) ?? [];
      list.push({ agent: group, mtime });
      byName.set(e.name, list);
    }
  }
  const out: { name: string; agents: string[]; newestAgent: string }[] = [];
  for (const [name, holders] of byName) {
    if (holders.length < 2) continue;
    holders.sort((a, b) => b.mtime - a.mtime);
    out.push({ name, agents: holders.map((h) => h.agent), newestAgent: holders[0].agent });
  }
  return out.sort((a, b) => b.agents.length - a.agents.length);
}

/**
 * Promote a duplicated scoped skill into the shared pool: the NEWEST copy
 * becomes the pooled version; every agent's own copy moves to its .archive/
 * (never deleted) so the pool serves them all from the next spawn. Owner-gated
 * at the route — this is the one learning-loop write with install-wide reach.
 */
export function promoteScopedSkill(
  name: string,
  dataDir: string = DATA_DIR,
  poolDir: string = path.join(process.cwd(), 'data', 'user-skills'),
): { ok: boolean; error?: string } {
  const dup = findDuplicateScopedSkills(dataDir).find((d) => d.name === name);
  if (!dup) return { ok: false, error: 'Not duplicated across agents' };
  const poolDest = path.join(poolDir, name);
  if (fs.existsSync(poolDest)) return { ok: false, error: 'Already in the shared pool' };
  const newest = path.join(dataDir, 'v2-sessions', dup.newestAgent, '.claude-shared', 'skills', name);
  fs.mkdirSync(path.dirname(poolDest), { recursive: true });
  fs.cpSync(newest, poolDest, { recursive: true });
  for (const agent of dup.agents) {
    const skillsDir = path.join(dataDir, 'v2-sessions', agent, '.claude-shared', 'skills');
    try {
      const archiveRoot = path.join(skillsDir, ARCHIVE_DIR);
      fs.mkdirSync(archiveRoot, { recursive: true });
      let dest = path.join(archiveRoot, name);
      if (fs.existsSync(dest)) dest = `${dest}-${Date.now()}`;
      fs.renameSync(path.join(skillsDir, name), dest);
    } catch {
      /* best-effort per agent — the pooled copy shadows any straggler anyway */
    }
  }
  return { ok: true };
}
