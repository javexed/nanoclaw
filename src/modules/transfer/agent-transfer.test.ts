/**
 * Agent transfer — the security-critical pure parts.
 *
 * isSafeTarEntry gates what an UNTRUSTED bundle may contain before any
 * extraction happens: absolute paths, traversal, and anything outside the
 * bundle's expected roots must be rejected (a hostile .tgz is the classic
 * write-anywhere primitive). exportTarArgs must always carry the junk
 * excludes and the conversation gating.
 */
import { describe, expect, it } from 'vitest';

import { CONVERSATION_DIRS, EXCLUDE_ALWAYS, exportTarArgs, isSafeTarEntry } from './agent-transfer.js';

describe('isSafeTarEntry', () => {
  it('accepts the bundle layout', () => {
    for (const e of [
      'manifest.json',
      'db/agent_group.json',
      'files/workspace/CLAUDE.md',
      'files/workspace/deep/nested/file.txt',
      'files/claude-shared/skills/foo/SKILL.md',
      'files/session-dbs/sess-1/inbound.db',
    ]) {
      expect(isSafeTarEntry(e), e).toBe(true);
    }
  });

  it('rejects traversal, absolute paths, and out-of-root members', () => {
    for (const e of [
      '/etc/passwd',
      '../outside',
      'files/workspace/../../escape',
      'files/../manifest.json',
      'db/../../x',
      'random.txt',
      'files/other/thing',
      'files\\workspace\\win.txt',
      '',
    ]) {
      expect(isSafeTarEntry(e), e).toBe(false);
    }
  });
});

describe('exportTarArgs', () => {
  const group = { id: 'ag-x', folder: 'nonexistent-folder-for-args-test' };

  it('always excludes rebuildable junk', () => {
    const args = exportTarArgs('/tmp/stage', group, false);
    for (const e of EXCLUDE_ALWAYS) expect(args).toContain(`--exclude=${e}`);
  });

  it('gates conversation state on the flag', () => {
    const without = exportTarArgs('/tmp/stage', group, false);
    for (const d of CONVERSATION_DIRS) expect(without).toContain(`--exclude=.claude-shared/${d}`);
    const withConvos = exportTarArgs('/tmp/stage', group, true);
    for (const d of CONVERSATION_DIRS) expect(withConvos).not.toContain(`--exclude=.claude-shared/${d}`);
  });
});
