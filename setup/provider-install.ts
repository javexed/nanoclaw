/**
 * Install-only entry for a manifest-style provider: the payload copy + barrel
 * wiring + CLI-manifest merge, WITHOUT auth or build.
 *
 * `provider-auth` bundles install + build + auth for the interactive setup flow.
 * The webchat "Install <provider>" button needs just the install half — build
 * (host + image) and the host restart are the caller's job, run and gated
 * separately so they can be streamed and a failure can abort before restart.
 *
 *   pnpm exec tsx setup/index.ts --step provider-install codex
 */
import { applyProviderSkill } from './providers/install.js';

// Mirror provider-auth.ts's map — the manifest-style providers whose install is
// a directive-engine apply of their SKILL.md (not a drift-prone add-<name>.sh).
const INSTALL_SKILLS: Record<string, string> = {
  codex: '.claude/skills/add-codex',
};

export async function run(args: string[]): Promise<void> {
  const name = args[0]?.trim().toLowerCase();
  const skillDir = name ? INSTALL_SKILLS[name] : undefined;
  if (!skillDir) {
    console.error(
      `Usage: pnpm exec tsx setup/index.ts --step provider-install <provider>\n` +
        `Known: ${Object.keys(INSTALL_SKILLS).join(', ')}`,
    );
    process.exit(1);
  }
  console.log(`Installing the ${name} provider payload…`);
  const { changed, blockers } = await applyProviderSkill(skillDir, process.cwd());
  if (blockers.length) {
    console.error(`Couldn't install ${name}: ${blockers.join('; ')}`);
    process.exit(1);
  }
  console.log(changed ? `${name} payload installed — rebuild + restart to load it.` : `${name} already present.`);
}
