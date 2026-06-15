/**
 * Tests for computeSwCacheVersion — the derived service-worker cache name that
 * replaced the hand-bumped `nanoclaw-chat-vNNN` constant. The version must be
 * deterministic, change when any served asset changes, and be insensitive to
 * sw.js itself (whose content embeds the version, which would otherwise be
 * circular).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { computeSwCacheVersion } from './server.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swcache-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1);');
  fs.writeFileSync(path.join(dir, 'style.css'), 'body{}');
  fs.writeFileSync(path.join(dir, 'sw.js'), "const CACHE = '__CACHE_VERSION__';");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('computeSwCacheVersion', () => {
  it('produces a stable nanoclaw-chat- prefixed name', () => {
    const v = computeSwCacheVersion(dir);
    expect(v).toMatch(/^nanoclaw-chat-[0-9a-f]{12}$/);
  });

  it('is deterministic for identical assets', () => {
    expect(computeSwCacheVersion(dir)).toBe(computeSwCacheVersion(dir));
  });

  it('changes when an asset changes', () => {
    const before = computeSwCacheVersion(dir);
    fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(2);');
    expect(computeSwCacheVersion(dir)).not.toBe(before);
  });

  it('changes when an asset is added', () => {
    const before = computeSwCacheVersion(dir);
    fs.writeFileSync(path.join(dir, 'logo.svg'), '<svg/>');
    expect(computeSwCacheVersion(dir)).not.toBe(before);
  });

  it('ignores sw.js content (avoids the self-referential hash)', () => {
    const before = computeSwCacheVersion(dir);
    fs.writeFileSync(path.join(dir, 'sw.js'), "const CACHE = 'nanoclaw-chat-something-else';");
    expect(computeSwCacheVersion(dir)).toBe(before);
  });

  it('returns a stable fallback when the directory is unreadable', () => {
    expect(computeSwCacheVersion(path.join(dir, 'does-not-exist'))).toBe('nanoclaw-chat-dev');
  });
});
