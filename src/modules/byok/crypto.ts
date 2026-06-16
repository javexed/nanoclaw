/**
 * At-rest encryption for OAuth (subscription) BYOK tokens.
 *
 * Why this exists: OneCLI cannot carry an OAuth token (no refresh, can't put the
 * SDK in OAuth mode), so unlike API-key BYOK — where the key lives only in the
 * OneCLI vault and the host never holds it — OAuth tokens must be stored by the
 * host and injected into the per-member container at spawn. We keep them
 * encrypted at rest with AES-256-GCM under a host-local 0600 keyfile.
 *
 * This is the deliberate, signed-off cost of subscription support (the host can
 * decrypt these). It is NOT a security theater: the host already runs every
 * container, so it is not a new trust boundary — only a new at-rest artifact.
 * The keyfile sits beside the central DB and is generated on first use.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';

const KEY_PATH = path.join(DATA_DIR, 'byok-oauth.key');
const ALGO = 'aes-256-gcm';
const NONCE_BYTES = 12;

let cachedKey: Buffer | null = null;

/** Load the AES key, generating a fresh 32-byte 0600 keyfile on first use. */
function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  try {
    const raw = fs.readFileSync(KEY_PATH);
    if (raw.length !== 32) throw new Error(`byok-oauth.key has wrong length (${raw.length}, want 32)`);
    cachedKey = raw;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const key = crypto.randomBytes(32);
    fs.writeFileSync(KEY_PATH, key, { mode: 0o600 });
    fs.chmodSync(KEY_PATH, 0o600); // enforce even if umask widened the create
    cachedKey = key;
  }
  return cachedKey;
}

export interface SealedToken {
  enc: Buffer; // ciphertext with the 16-byte GCM auth tag appended
  nonce: Buffer;
}

/** Encrypt a token string → { enc (ciphertext+tag), nonce }. */
export function sealToken(plaintext: string): SealedToken {
  const key = loadKey();
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { enc: Buffer.concat([ct, tag]), nonce };
}

/** Decrypt { enc, nonce } → token string. Throws on tamper / wrong key. */
export function openToken(enc: Buffer, nonce: Buffer): string {
  const key = loadKey();
  const ct = enc.subarray(0, enc.length - 16);
  const tag = enc.subarray(enc.length - 16);
  const decipher = crypto.createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Test-only: reset the cached key so a fresh keyfile path is re-read. */
export function _resetKeyCacheForTests(): void {
  cachedKey = null;
}
