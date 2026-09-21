#!/usr/bin/env tsx
/**
 * Install one provider's `/add-<name>` skill, headlessly, from a single command.
 *
 * `setup/providers/install.ts` already does this in-process, and the terminal
 * setup flow calls it directly. This is the same call behind a command line,
 * for callers that cannot import it: the host build is rooted at `src/`
 * (tsconfig rootDir), so `src/channels/web` can reach `setup/` only by spawning
 * it. `scripts/update-skills.ts` is not that caller — it REFRESHES skills it
 * detects in the provider barrels, and a provider that isn't installed yet is
 * exactly the one it cannot see.
 *
 * Streams plain lines on stdout so a progress view can render them, and exits
 * non-zero when the apply left anything non-deterministic behind — a partial
 * provider install is worse than none, because the barrels say it is there.
 *
 *   tsx scripts/install-provider.ts .claude/skills/add-opencode [--refresh]
 */
import path from 'node:path';

import { applyProviderSkill } from '../setup/providers/install.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const skillDir = args.find((a) => !a.startsWith('--'));
  if (!skillDir) {
    console.error('usage: install-provider.ts <skill-dir> [--refresh]');
    process.exit(2);
  }
  const root = process.cwd();
  const mode = args.includes('--refresh') ? ('refresh' as const) : ('install' as const);
  console.log(`Applying ${path.basename(skillDir)} (${mode})`);

  const result = await applyProviderSkill(skillDir, root, { mode });

  for (const entry of result.apply.journal) {
    const what =
      'path' in entry ? entry.path : 'cmd' in entry ? entry.cmd.split('\n')[0] : 'key' in entry ? entry.key : '';
    console.log(`  ${entry.op} ${what}`.trimEnd());
  }
  console.log(`Contract verification: ${result.verification.status}`);

  if (result.blockers.length > 0) {
    console.error('Did not fully apply:');
    for (const b of result.blockers) console.error(`  - ${b}`);
    process.exit(1);
  }
  console.log(result.changed ? 'Applied.' : 'Already present — nothing to change.');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
