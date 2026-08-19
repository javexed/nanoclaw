/**
 * Packaging invariants for the Grok CLI.
 *
 * All three exist because the failure they prevent is invisible until an agent
 * tries to run: a floating version that skews against the ACP client, a binary
 * hidden by the provider's own mount, or a binary the unprivileged user cannot
 * execute.
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const DOCKERFILE = fs.readFileSync(path.join(process.cwd(), 'container', 'Dockerfile'), 'utf8');
const BUILD_SH = fs.readFileSync(path.join(process.cwd(), 'container', 'build.sh'), 'utf8');

/** The ARG line and the RUN block that installs the CLI. */
const grokBlock = (): string => {
  const start = DOCKERFILE.indexOf('ARG GROK_VERSION');
  expect(start).toBeGreaterThan(-1);
  return DOCKERFILE.slice(start, DOCKERFILE.indexOf('\n\n', start));
};

describe('the version is pinned', () => {
  it('ARG GROK_VERSION carries an exact version, never a floating tag', () => {
    const match = DOCKERFILE.match(/ARG GROK_VERSION=(\S+)/);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(match![1]).not.toBe('latest');
  });

  it('the installer is invoked with that pin, not bare', () => {
    // `install.sh | bash` with no argument installs whatever is newest today.
    expect(grokBlock()).toMatch(/bash -s "\$\{GROK_VERSION\}"/);
  });

  it('build.sh can override the pin from env or .env', () => {
    expect(BUILD_SH).toMatch(/GROK_VERSION/);
    expect(BUILD_SH).toMatch(/--build-arg "GROK_VERSION=/);
  });
});

describe('the binary cannot collide with the provider mount', () => {
  it('installs outside ~/.grok', () => {
    // The provider mounts a host dir over ~/.grok for the session store; a
    // binary under it would be hidden and every spawn would fail.
    expect(grokBlock()).toMatch(/GROK_BIN_DIR=\/usr\/local\/bin/);
  });

  it('asserts the collision at BUILD time rather than leaving it to a spawn', () => {
    expect(grokBlock()).toMatch(/test ! -e \/home\/node\/\.grok\/bin\/grok/);
  });

  it('sets the env var on the bash side of the pipe', () => {
    // `VAR=x curl ... | bash` exports to curl; the installer never sees it and
    // silently falls back to ~/.grok/bin.
    expect(grokBlock()).toMatch(/\|\s*GROK_BIN_DIR=\/usr\/local\/bin bash/);
  });
});

describe('the binary is usable by the unprivileged agent user', () => {
  it('dereferences the symlink into a real file', () => {
    // GROK_BIN_DIR only places a symlink; the payload lands in
    // /root/.grok/downloads, which `node` cannot traverse.
    const block = grokBlock();
    expect(block).toMatch(/readlink -f \/usr\/local\/bin\/grok/);
    expect(block).toMatch(/mv \/tmp\/grok\.bin \/usr\/local\/bin\/grok/);
  });

  it('makes it world-executable and removes the root-owned tree', () => {
    expect(grokBlock()).toMatch(/chmod 0755 \/usr\/local\/bin\/grok/);
    expect(grokBlock()).toMatch(/rm -rf \/root\/\.grok/);
  });

  it('installs before the image drops to USER node', () => {
    // Writing /usr/local/bin needs root.
    expect(DOCKERFILE.indexOf('ARG GROK_VERSION')).toBeLessThan(DOCKERFILE.indexOf('USER node'));
  });
});
