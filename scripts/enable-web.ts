// Enable (or disable) the in-tree web channel by setting its env flag.
// Web ships disabled (`WEB_ENABLED=false` in .env.example), so an
// idempotent set-if-absent (nc:env-set) can't flip it — this force-upserts.
// Localhost-only by design: opening the port + minting a bearer token is left
// to the in-app first-run wizard. Called by the /add-web skill.
import { upsertEnvVar } from '../setup/set-env.js';

const disable = process.argv.includes('--disable');
const enabled = disable ? 'false' : 'true';
upsertEnvVar('WEB_ENABLED', enabled);
if (!disable) {
  // Force loopback: a lingering WEB_HOST=0.0.0.0 from a prior networked
  // run must not silently keep the port open when re-enabling here.
  upsertEnvVar('WEB_HOST', '127.0.0.1');
}
console.log(`WEB_ENABLED=${enabled}${disable ? '' : ' WEB_HOST=127.0.0.1 (localhost only)'}`);
