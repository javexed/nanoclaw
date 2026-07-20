import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock log
vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
  registerContainerConfigAugmentor,
  resolveContainerConfigAugmentation,
  makeContainerWritable,
} from './container-runtime.js';
import fs from 'fs';
import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('container config augmentors', () => {
  it('returns {} when no augmentor is registered (core default)', () => {
    // Note: other suites may register augmentors; assert our key specifically.
    expect(resolveContainerConfigAugmentation('g-none').lenientOutput).toBeUndefined();
  });

  it('merges a registered augmentor keyed by agent group', () => {
    registerContainerConfigAugmentor((id) => (id === 'g-ollama' ? { lenientOutput: true } : {}));
    expect(resolveContainerConfigAugmentation('g-ollama')).toMatchObject({ lenientOutput: true });
    expect(resolveContainerConfigAugmentation('g-other').lenientOutput).toBeUndefined();
  });

  it('isolates a throwing augmentor — never breaks spawning', () => {
    registerContainerConfigAugmentor(() => {
      throw new Error('augmentor bug');
    });
    registerContainerConfigAugmentor((id) => (id === 'g-ok' ? { lenientOutput: true } : {}));
    // The throwing augmentor is swallowed; the healthy one still contributes.
    expect(resolveContainerConfigAugmentation('g-ok')).toMatchObject({ lenientOutput: true });
  });
});

describe('stopContainer', () => {
  it('calls docker stop for valid container names', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-test-123`, {
      stdio: 'pipe',
    });
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow('Invalid container name');
    expect(() => stopContainer('foo$(whoami)')).toThrow('Invalid container name');
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(log.debug).toHaveBeenCalledWith('Container runtime already running');
  });

  it('throws when docker info fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow('Container runtime is required but failed to start');
    expect(log.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('filters ps by the install label so peers are not reaped', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      expect.any(Object),
    );
  });

  it('stops orphaned nanoclaw containers', () => {
    // docker ps returns container names, one per line
    mockExecSync.mockReturnValueOnce('nanoclaw-group1-111\nnanoclaw-group2-222\n');
    // stop calls succeed
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // ps + 2 stop calls
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(2, `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group1-111`, {
      stdio: 'pipe',
    });
    expect(mockExecSync).toHaveBeenNthCalledWith(3, `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group2-222`, {
      stdio: 'pipe',
    });
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'],
    });
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(); // should not throw

    expect(log.warn).toHaveBeenCalledWith(
      'Failed to clean up orphaned containers',
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-a-1\nnanoclaw-b-2\n');
    // First stop fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    // Second stop succeeds
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-a-1', 'nanoclaw-b-2'],
    });
  });
});

describe('makeContainerWritable', () => {
  beforeEach(() => vi.restoreAllMocks());

  // Dirent-like stub — the walk keys off isDirectory()/isSymbolicLink().
  const dirent = (name: string, kind: 'dir' | 'file' | 'link') =>
    ({ name, isDirectory: () => kind === 'dir', isSymbolicLink: () => kind === 'link' }) as fs.Dirent;

  it('no-ops when the host is not root (UIDs already match the container)', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(1000);
    const chown = vi.spyOn(fs, 'lchownSync').mockImplementation(() => {});
    makeContainerWritable('/opt/nanoclaw/groups/x', true);
    expect(chown).not.toHaveBeenCalled();
  });

  it('chowns just the top dir to UID 1000 when root and not recursive', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    const chown = vi.spyOn(fs, 'lchownSync').mockImplementation(() => {});
    const readdir = vi.spyOn(fs, 'readdirSync').mockImplementation(() => [] as never);
    makeContainerWritable('/g');
    expect(chown).toHaveBeenCalledTimes(1);
    expect(chown).toHaveBeenCalledWith('/g', 1000, 1000);
    expect(readdir).not.toHaveBeenCalled(); // non-recursive: no descent
  });

  it('recursively lchowns the whole tree when root + recursive (covers outbound.db)', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    const chown = vi.spyOn(fs, 'lchownSync').mockImplementation(() => {});
    vi.spyOn(fs, 'lstatSync').mockReturnValue({ isDirectory: () => true } as fs.Stats); // top target
    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike) => {
      if (String(p) === '/s') return [dirent('outbound.db', 'file'), dirent('outbox', 'dir')] as never;
      if (String(p) === '/s/outbox') return [dirent('file.png', 'file')] as never;
      return [] as never; // files → no children
    }) as typeof fs.readdirSync);
    makeContainerWritable('/s', true);
    const targets = chown.mock.calls.map((c) => c[0]);
    expect(targets).toEqual(expect.arrayContaining(['/s', '/s/outbound.db', '/s/outbox', '/s/outbox/file.png']));
    expect(chown).toHaveBeenCalledWith('/s/outbound.db', 1000, 1000);
  });

  it('SECURITY: lchowns a planted symlink but never follows or recurses through it', () => {
    // The agent controls .claude-shared/session contents and could `ln -s / evil`.
    // The walk must lchown the link itself (harmless) and NEVER descend into its
    // target — otherwise a root host would chown the whole filesystem.
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    const chown = vi.spyOn(fs, 'lchownSync').mockImplementation(() => {});
    vi.spyOn(fs, 'lstatSync').mockReturnValue({ isDirectory: () => true } as fs.Stats); // top target is a real dir
    const readdir = vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike) => {
      if (String(p) === '/s') return [dirent('evil', 'link')] as never; // `ln -s / evil`
      return [dirent('etc', 'dir'), dirent('root', 'dir')] as never; // would appear IF the link were followed
    }) as typeof fs.readdirSync);
    makeContainerWritable('/s', true);
    const targets = chown.mock.calls.map((c) => c[0]);
    expect(targets).toEqual(['/s', '/s/evil']); // link chowned, target NOT
    expect(readdir).not.toHaveBeenCalledWith('/s/evil', expect.anything()); // never traversed
    expect(targets).not.toContain('/s/evil/etc'); // nothing under the link target touched
  });
});
