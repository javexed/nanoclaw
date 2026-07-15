import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Per-agent-group network egress mode (security model §egress):
 *   NULL / 'open' — full egress (default; tailnet-first product).
 *   'host-only'   — internal docker network: host services (OneCLI, LiteLLM,
 *                   MCP relay) reachable, internet unreachable.
 *   'none'        — no network at all.
 */
export const moduleContainerEgress: Migration = {
  version: 204,
  name: 'container-egress',
  up(db: Database.Database) {
    const has = (db.prepare("PRAGMA table_info('container_configs')").all() as Array<{ name: string }>).some(
      (c) => c.name === 'egress',
    );
    if (!has) db.exec(`ALTER TABLE container_configs ADD COLUMN egress TEXT`);
  },
};
