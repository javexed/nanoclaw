import { describe, expect, it } from 'vitest';

import path from 'node:path';

import { findBinDir, packageManagerCandidates } from './host-path.js';

describe('findBinDir', () => {
  const has =
    (...paths: string[]) =>
    (p: string) =>
      paths.includes(p);

  it('returns the first candidate that actually holds the binary', () => {
    expect(findBinDir('pnpm', ['/a', '/b', '/c'], has('/b/pnpm', '/c/pnpm'))).toBe('/b');
  });

  it('skips a directory that has node but not pnpm — the bug this exists for', () => {
    // The service ran mise's node 26.5.0, whose bin has node but no pnpm, while
    // pnpm sat in the node 22 install. Splicing the node dir alone gave ENOENT.
    expect(
      findBinDir('pnpm', ['/mise/26.5.0/bin', '/mise/shims'], has('/mise/26.5.0/bin/node', '/mise/shims/pnpm')),
    ).toBe('/mise/shims');
  });

  it('is null when nothing has it, rather than guessing', () => {
    expect(findBinDir('pnpm', ['/a', '/b'], () => false)).toBeNull();
  });

  it('ignores empty candidates (unset env vars)', () => {
    expect(findBinDir('pnpm', ['', '/b'], has('/b/pnpm'))).toBe('/b');
  });
});

describe('packageManagerCandidates', () => {
  it('looks beside our own node first', () => {
    expect(packageManagerCandidates({}, '/home/x')[0]).toBe(path.dirname(process.execPath));
  });

  it('includes PNPM_HOME, npm_execpath’s dir, and the version-manager shims', () => {
    const c = packageManagerCandidates({ PNPM_HOME: '/p/home', npm_execpath: '/n/lib/npm.js' }, '/home/x');
    expect(c).toContain('/p/home');
    expect(c).toContain('/n/lib');
    expect(c).toContain('/home/x/.local/share/mise/shims');
    expect(c).toContain('/home/x/.asdf/shims');
    expect(c).toContain('/home/x/.volta/bin');
  });
});
