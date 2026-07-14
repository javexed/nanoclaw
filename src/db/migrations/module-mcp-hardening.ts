import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * MCP hardening columns on webchat_mcp_servers (all JSON, all nullable):
 *
 *   health        {status:'ok'|'down'|'auth'|'drift', at, reason?, toolCount?}
 *                 — last sweep re-probe result (remote servers only).
 *   pinned_tools  {hash, at, tools:[{name,description}]}
 *                 — the tool surface approved at attach time; the sweep
 *                 re-hashes against it (rug-pull detection).
 *   drift         {at, added:[], removed:[], changed:[]}
 *                 — set when a re-probe hash mismatches; cleared by re-approve.
 *   enabled_tools string[] — tool allowlist for this server (null = all).
 *   auth          {kind:'bearer'|'oauth', token?, oauth?:{...}}
 *                 — credentials held HOST-side for the relay to inject; never
 *                 materialized into container.json.
 */
export const moduleMcpHardening: Migration = {
  version: 202,
  name: 'webchat-mcp-hardening',
  up(db: Database.Database) {
    const cols = new Set(
      (db.prepare("PRAGMA table_info('webchat_mcp_servers')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const col of ['health', 'pinned_tools', 'drift', 'enabled_tools', 'auth']) {
      if (!cols.has(col)) db.exec(`ALTER TABLE webchat_mcp_servers ADD COLUMN ${col} TEXT`);
    }
    // Per-assignment relay token: the container-side indirection credential for
    // the MCP auth relay. Scoped to ONE (agent group, server) pair — the real
    // secret stays host-side in webchat_mcp_servers.auth.
    const acols = new Set(
      (db.prepare("PRAGMA table_info('webchat_agent_mcp_servers')").all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    if (!acols.has('relay_token')) db.exec(`ALTER TABLE webchat_agent_mcp_servers ADD COLUMN relay_token TEXT`);
  },
};
