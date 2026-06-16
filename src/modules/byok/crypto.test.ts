import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { sealToken, openToken, _resetKeyCacheForTests } from './crypto.js';

const KEY_PATH = path.join(DATA_DIR, 'byok-oauth.key');

// The keyfile lives beside the central DB. Isolate each test: drop the cached
// key + the on-disk file so a fresh key is generated, and clean up after.
beforeEach(() => {
  _resetKeyCacheForTests();
  fs.rmSync(KEY_PATH, { force: true });
});
afterEach(() => {
  _resetKeyCacheForTests();
  fs.rmSync(KEY_PATH, { force: true });
});

describe('byok oauth crypto', () => {
  it('round-trips a token', () => {
    const { enc, nonce } = sealToken('sk-ant-oat-abc123');
    expect(openToken(enc, nonce)).toBe('sk-ant-oat-abc123');
  });

  it('generates a 0600 keyfile on first use', () => {
    sealToken('x');
    const mode = fs.statSync(KEY_PATH).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('produces distinct ciphertext for the same plaintext (random nonce)', () => {
    const a = sealToken('same');
    const b = sealToken('same');
    expect(a.enc.equals(b.enc)).toBe(false);
    expect(openToken(a.enc, a.nonce)).toBe('same');
    expect(openToken(b.enc, b.nonce)).toBe('same');
  });

  it('rejects tampered ciphertext (GCM auth)', () => {
    const { enc, nonce } = sealToken('secret');
    enc[0] ^= 0xff; // flip a byte
    expect(() => openToken(enc, nonce)).toThrow();
  });

  it('rejects a wrong nonce', () => {
    const { enc } = sealToken('secret');
    const wrong = Buffer.alloc(12, 7);
    expect(() => openToken(enc, wrong)).toThrow();
  });
});
