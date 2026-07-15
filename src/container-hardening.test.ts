/**
 * Container hardening baseline (docs/SECURITY.md §Container Hardening):
 * cap-drop ALL with the minimal file-ownership adds, no-new-privileges, and
 * a pids limit — always on unless the explicit escape hatch is set.
 */
import { describe, expect, it } from 'vitest';

import { containerHardeningArgs } from './container-runner.js';

describe('containerHardeningArgs', () => {
  it('drops all caps, blocks privilege escalation, limits pids by default', () => {
    const args = containerHardeningArgs({} as NodeJS.ProcessEnv);
    expect(args.join(' ')).toContain('--cap-drop ALL');
    expect(args.join(' ')).toContain('--security-opt no-new-privileges');
    expect(args.join(' ')).toContain('--pids-limit 512');
    // only the file-ownership caps package managers need
    const adds = args.filter((_, i) => args[i - 1] === '--cap-add');
    expect(adds.sort()).toEqual(['CHOWN', 'DAC_OVERRIDE', 'FOWNER']);
  });

  it('pids limit is overridable; the escape hatch disables everything', () => {
    expect(containerHardeningArgs({ NANOCLAW_CONTAINER_PIDS_LIMIT: '1024' } as NodeJS.ProcessEnv)).toContain('1024');
    expect(containerHardeningArgs({ NANOCLAW_CONTAINER_NO_HARDEN: '1' } as NodeJS.ProcessEnv)).toEqual([]);
  });
});
