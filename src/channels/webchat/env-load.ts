/**
 * Webchat env preload — side-effect module.
 *
 * The webchat adapter reads its config via `process.env.WEBCHAT_*` at
 * module-init time (top-level `const X = process.env.X || ...`). v2 trunk's
 * service runners (systemd unit, launchd plist) deliberately do NOT load
 * `.env` into process.env — `src/env.ts` keeps secrets out of the inherited
 * environment by reading on demand via `readEnvFile`.
 *
 * That means a service-managed host has `WEBCHAT_ENABLED` unset and the
 * factory returns null ("Channel credentials missing, skipping").
 *
 * This shim bridges the two: at import time it reads the webchat-relevant
 * keys from `.env` and sets them on `process.env` ONLY if not already set
 * (so an explicit Environment= line in the unit still wins). Importing it
 * first in `webchat/index.ts` guarantees it runs before any transitive
 * import (server.ts, auth.ts, etc.) evaluates its module-level constants.
 *
 * Only webchat-specific keys are populated — nothing leaks for other
 * channels.
 */
import { readEnvFile } from '../../env.js';

const WEBCHAT_ENV_KEYS = [
  'WEBCHAT_ENABLED',
  'WEBCHAT_HOST',
  'WEBCHAT_PORT',
  'WEBCHAT_TOKEN',
  'WEBCHAT_TAILSCALE',
  'WEBCHAT_TRUSTED_PROXY_IPS',
  'WEBCHAT_TRUSTED_PROXY_HEADER',
  'WEBCHAT_TLS_CERT',
  'WEBCHAT_TLS_KEY',
  'WEBCHAT_PUBLIC_DIR',
  'WEBCHAT_VAPID_PUBLIC_KEY',
  'WEBCHAT_VAPID_PRIVATE_KEY',
  'WEBCHAT_VAPID_SUBJECT',
  'WEBCHAT_DRAFTER_MODEL',
  'WEBCHAT_BLOCK_PRIVATE_IPS',
  'OLLAMA_HOST',
  'AGENT_DISPLAY_NAME',
];

const fromFile = readEnvFile(WEBCHAT_ENV_KEYS);
for (const [k, v] of Object.entries(fromFile)) {
  if (process.env[k] === undefined) process.env[k] = v;
}
