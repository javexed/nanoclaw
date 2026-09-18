/**
 * Web env preload — side-effect module.
 *
 * The web adapter reads its config via `process.env.WEB_*` at
 * module-init time (top-level `const X = process.env.X || ...`). v2 trunk's
 * service runners (systemd unit, launchd plist) deliberately do NOT load
 * `.env` into process.env — `src/env.ts` keeps secrets out of the inherited
 * environment by reading on demand via `readEnvFile`.
 *
 * That means a service-managed host has `WEB_ENABLED` unset and the
 * factory returns null ("Channel credentials missing, skipping").
 *
 * This shim bridges the two: at import time it reads the web-relevant
 * keys from `.env` and sets them on `process.env` ONLY if not already set
 * (so an explicit Environment= line in the unit still wins). Importing it
 * first in `web/index.ts` guarantees it runs before any transitive
 * import (server.ts, auth.ts, etc.) evaluates its module-level constants.
 *
 * Only web-specific keys are populated — nothing leaks for other
 * channels.
 */
import { readEnvFile } from '../../env.js';

const WEB_ENV_KEYS = [
  'WEB_ENABLED',
  'WEB_HOST',
  'WEB_PORT',
  'WEB_TOKEN',
  'WEB_TAILSCALE',
  'WEB_TLS_CERT',
  'WEB_TLS_KEY',
  'WEB_PUBLIC_DIR',
  'WEB_DRAFTER_MODEL',
  'WEB_BLOCK_PRIVATE_IPS',
  'OLLAMA_HOST',
  'AGENT_DISPLAY_NAME',
];

const fromFile = readEnvFile(WEB_ENV_KEYS);
for (const [k, v] of Object.entries(fromFile)) {
  if (process.env[k] === undefined) process.env[k] = v;
}
