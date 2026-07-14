/**
 * MCP auth relay — the host-side hop that keeps MCP credentials out of
 * containers (item 7 of the MCP hardening review).
 *
 * A remote MCP server with host-side auth (webchat_mcp_servers.auth) is synced
 * into container configs with its url REWRITTEN to
 *   http://host.docker.internal:<port>/relay/<serverId>
 * plus a per-(agent group, server) relay token header. This listener validates
 * the token against the assignment row, injects the real Authorization header
 * (refreshing OAuth tokens as needed), and streams the exchange both ways —
 * Streamable HTTP POSTs and SSE GET streams alike.
 *
 * Trust model: the relay token is an indirection credential — it names one
 * (group, server) pair and is useless anywhere else. Revoking = unassigning.
 * The real secret never leaves the host. Plain HTTP is fine here: the only
 * legitimate path is the docker bridge (and tailnet links are WireGuard-
 * encrypted regardless); the token gates every request.
 */
import http from 'http';
import { Readable } from 'stream';

import { log } from '../../log.js';
import { getDb } from '../../db/connection.js';
import { effectiveAuthHeader, parseMcpAuth, refreshOAuthToken } from './mcp-auth.js';
import { getWebchatMcpServer, MCP_RELAY_PORT } from './mcp-registry.js';

export { MCP_RELAY_PORT };
const RELAY_TOKEN_HEADER = 'x-nanoclaw-relay';

/** Hop-by-hop / host-scoped headers that must not be forwarded either way. */
const STRIP_REQUEST = new Set(['host', 'connection', 'content-length', RELAY_TOKEN_HEADER, 'authorization']);
const STRIP_RESPONSE = new Set(['connection', 'transfer-encoding', 'content-length', 'keep-alive']);

function lookupAssignment(token: string): { agent_group_id: string; mcp_server_id: string } | undefined {
  return getDb()
    .prepare(`SELECT agent_group_id, mcp_server_id FROM webchat_agent_mcp_servers WHERE relay_token = ?`)
    .get(token) as { agent_group_id: string; mcp_server_id: string } | undefined;
}

async function handleRelay(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const m = (req.url || '').match(/^\/relay\/([^/?]+)(\/[^?]*)?(\?.*)?$/);
  if (!m) {
    res.writeHead(404).end('not found');
    return;
  }
  const [, serverId, subPath = '', query = ''] = m;
  const token = String(req.headers[RELAY_TOKEN_HEADER] || '');
  const assignment = token ? lookupAssignment(token) : undefined;
  if (!assignment || assignment.mcp_server_id !== serverId) {
    res.writeHead(403).end('relay token invalid for this server');
    return;
  }
  const server = getWebchatMcpServer(serverId);
  if (!server?.url) {
    res.writeHead(502).end('server has no URL');
    return;
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (STRIP_REQUEST.has(k.toLowerCase()) || typeof v !== 'string') continue;
    headers[k] = v;
  }
  // Operator-set static headers still apply under the relay…
  try {
    Object.assign(headers, server.headers ? (JSON.parse(server.headers) as Record<string, string>) : {});
  } catch {
    /* malformed headers JSON — forward without */
  }
  // …and the host-side credential is injected last, so it always wins.
  const authHeader = await effectiveAuthHeader(server);
  if (authHeader) headers['authorization'] = authHeader;

  const target = server.url.replace(/\/$/, '') + subPath + query;
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE';

  const forward = async (): Promise<Response> =>
    fetch(target, {
      method: req.method,
      headers,
      ...(hasBody ? { body: Readable.toWeb(req) as unknown as RequestInit['body'], duplex: 'half' } : {}),
      signal: AbortSignal.timeout(10 * 60 * 1000), // long-poll friendly
    } as RequestInit);

  try {
    let upstream = await forward();
    // One retry on 401 with a fresh OAuth token — the classic mid-stream expiry.
    if (upstream.status === 401 && !hasBody) {
      const auth = parseMcpAuth(server);
      if (auth?.kind === 'oauth' && auth.refresh_token) {
        const refreshed = await refreshOAuthToken(server.id, auth);
        if (refreshed?.access_token) {
          headers['authorization'] = `Bearer ${refreshed.access_token}`;
          upstream = await forward();
        }
      }
    }
    const outHeaders: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      if (!STRIP_RESPONSE.has(k.toLowerCase())) outHeaders[k] = v;
    });
    res.writeHead(upstream.status, outHeaders);
    if (upstream.body) {
      // Stream — SSE and chunked Streamable HTTP responses flow through live.
      Readable.fromWeb(upstream.body as never).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    log.warn('MCP relay forward failed', { serverId, err: String(err) });
    if (!res.headersSent) res.writeHead(502);
    res.end('relay forward failed');
  }
}

let relayServer: http.Server | null = null;

export function startMcpRelay(): void {
  if (relayServer) return;
  relayServer = http.createServer((req, res) => {
    void handleRelay(req, res).catch((err) => {
      log.error('MCP relay handler threw', { err });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  relayServer.on('error', (err) => log.error('MCP relay listener error', { err: String(err) }));
  relayServer.listen(MCP_RELAY_PORT, '0.0.0.0', () => {
    log.info('MCP auth relay listening', { port: MCP_RELAY_PORT });
  });
}

export function stopMcpRelay(): void {
  relayServer?.close();
  relayServer = null;
}
