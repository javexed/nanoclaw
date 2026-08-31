// Enable (or disable) the in-tree webchat channel by setting its env flag.
// Webchat ships disabled (`WEBCHAT_ENABLED=false` in .env.example), so an
// idempotent set-if-absent (nc:env-set) can't flip it — this force-upserts.
// Localhost-only by design: opening the port + minting a bearer token is left
// to the in-app first-run wizard. Called by the /add-webchat skill.
import { upsertEnvVar } from '../setup/set-env.js';

const disable = process.argv.includes('--disable');
const enabled = disable ? 'false' : 'true';
upsertEnvVar('WEBCHAT_ENABLED', enabled);
if (!disable) {
  // Force loopback: a lingering WEBCHAT_HOST=0.0.0.0 from a prior networked
  // run must not silently keep the port open when re-enabling here.
  upsertEnvVar('WEBCHAT_HOST', '127.0.0.1');
}
console.log(`WEBCHAT_ENABLED=${enabled}${disable ? '' : ' WEBCHAT_HOST=127.0.0.1 (localhost only)'}`);
