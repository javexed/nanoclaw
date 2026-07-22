/**
 * Cold-spawn warmer (docs/webchat/design/cold-spawn.md): the warm container
 * must be inert — no network, hard memory cap, --rm, install-labeled so
 * cleanupOrphans can reap it — and must touch the same files a real spawn
 * reads (agent-runner src mount + the claude binary).
 */
import { describe, expect, it } from 'vitest';

import { buildWarmArgs } from './container-warm.js';

describe('buildWarmArgs', () => {
  const args = buildWarmArgs('nanoclaw-agent:latest', '/repo/container/agent-runner/src');

  it('is inert: no network, memory-capped, auto-removed, install-labeled', () => {
    const joined = args.join(' ');
    expect(joined).toContain('--network none');
    expect(joined).toContain('--memory 1g');
    expect(args).toContain('--rm');
    expect(joined).toMatch(/--label nanoclaw-install=/);
  });

  it('mounts the agent-runner source read-only at the real spawn path', () => {
    expect(args).toContain('/repo/container/agent-runner/src:/app/src:ro');
  });

  it('runs against the given image and touches the hot paths a spawn reads', () => {
    expect(args).toContain('nanoclaw-agent:latest');
    const script = args[args.length - 1];
    expect(script).toContain('/app/src/poll-loop.ts');
    expect(script).toContain('/app/src/providers/index.ts');
    expect(script).toContain('/pnpm/claude --version');
    // Never fail the warm run on an import that needs a /workspace mount.
    expect(script).toContain('catch');
    expect(script.endsWith('true')).toBe(true);
  });
});
