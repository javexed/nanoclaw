/**
 * Pre-import skill inspection (learning/skills review): given the fetched files
 * of a skill, produce the "what's inside" inventory and lint warnings shown
 * BEFORE anything is written. Pure functions — the fetch happens in the caller.
 *
 * The threat model this serves (docs/webchat/learning-loop.md §8 + market survey):
 *   - skills with scripts execute code in agent containers — that must be
 *     visible at the moment of decision, not discovered later;
 *   - hidden/bidirectional Unicode is a documented instruction-smuggling vector
 *     in SKILL.md files;
 *   - names mimicking official skills ("anthropic-*", "claude-*") from
 *     non-official sources are a documented impersonation pattern;
 *   - oversized SKILL.md bodies crowd agent context (spec guidance: <5k tokens).
 */

export interface SkillFileEntry {
  rel: string;
  content: Buffer;
}

export interface SkillInspection {
  files: number;
  totalBytes: number;
  /** Relative paths of files that are code (by extension or scripts/ dir). */
  scripts: string[];
  /** ~tokens of SKILL.md (chars/4) — the part that enters agent context. */
  skillMdTokens: number;
  /** Unique external hosts linked from markdown files. */
  externalHosts: string[];
  /** Human-readable findings, worst first. Empty = nothing suspicious. */
  warnings: string[];
}

const SCRIPT_EXTS = new Set([
  '.sh',
  '.bash',
  '.zsh',
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.rb',
  '.pl',
  '.ps1',
]);

// Zero-width and bidi-control characters that have no business in a SKILL.md:
// ZWSP..RTL mark, bidi embedding/overrides, word-joiner..invisible operators,
// soft hyphen, BOM.
const HIDDEN_UNICODE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u00AD\uFEFF]/g;

function ext(rel: string): string {
  const i = rel.lastIndexOf('.');
  return i === -1 ? '' : rel.slice(i).toLowerCase();
}

function isMarkdown(rel: string): boolean {
  const e = ext(rel);
  return e === '.md' || e === '.markdown' || e === '.txt';
}

/** Unique external hosts in markdown content, github's own hosts excluded. */
function externalHostsIn(text: string): string[] {
  const hosts = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/([^/\s)"'<>\]]+)/g)) {
    const host = m[1].toLowerCase().replace(/:\d+$/, '');
    if (host === 'github.com' || host.endsWith('.github.com') || host === 'raw.githubusercontent.com') continue;
    hosts.add(host);
  }
  return [...hosts].sort();
}

export function inspectSkillFiles(
  name: string,
  files: SkillFileEntry[],
  opts: { official?: boolean } = {},
): SkillInspection {
  const warnings: string[] = [];
  const scripts: string[] = [];
  const hosts = new Set<string>();
  let totalBytes = 0;
  let skillMdTokens = 0;

  for (const f of files) {
    totalBytes += f.content.length;
    if (SCRIPT_EXTS.has(ext(f.rel)) || /(^|\/)scripts\//.test(f.rel)) scripts.push(f.rel);
    if (!isMarkdown(f.rel)) continue;
    const text = f.content.toString('utf8');
    for (const h of externalHostsIn(text)) hosts.add(h);
    const hidden = text.match(HIDDEN_UNICODE);
    if (hidden) {
      warnings.push(
        `${f.rel} contains ${hidden.length} hidden Unicode character${hidden.length === 1 ? '' : 's'} ` +
          `(zero-width/bidi) — a known way to smuggle instructions past review`,
      );
    }
    if (f.rel === 'SKILL.md') skillMdTokens = Math.round(text.length / 4);
  }

  // Impersonation: official-sounding names from non-official sources. The
  // in-the-wild pattern is community skills squatting the vendor namespace.
  if (!opts.official && /^(anthropic|claude|nanoclaw)[-_]/.test(name)) {
    warnings.push(`The name "${name}" mimics an official namespace but the source is not official`);
  }
  if (scripts.length > 0) {
    warnings.push(
      `Ships ${scripts.length} script${scripts.length === 1 ? '' : 's'} — code that runs inside your agents. ` +
        `Review before importing`,
    );
  }
  if (skillMdTokens > 5000) {
    warnings.push(
      `SKILL.md is ~${skillMdTokens.toLocaleString()} tokens — large skills crowd agent context (guidance: under 5k)`,
    );
  }

  return {
    files: files.length,
    totalBytes,
    scripts: scripts.sort(),
    skillMdTokens,
    externalHosts: [...hosts].sort(),
    warnings,
  };
}
