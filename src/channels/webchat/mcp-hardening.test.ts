/**
 * MCP hardening invariants (review items 4, 5, 7):
 *   - tool-surface hashing is order-independent and description-sensitive
 *     (drift = the rug pull; a reordered list is NOT drift);
 *   - the drift diff names exactly what changed;
 *   - a server with host-side auth syncs into container config as a RELAY url
 *     + scoped token — the real credential never appears;
 *   - enabledTools flows into the config entry (the SDK allowlist enforces it).
 */
import { describe, expect, it } from 'vitest';

import {
  diffToolSurface,
  hashToolSurface,
  mcpServerToConfig,
  MCP_RELAY_PORT,
  type WebchatMcpServer,
} from './mcp-registry.js';

const T = (name: string, description = '') => ({ name, description });

function row(over: Partial<WebchatMcpServer>): WebchatMcpServer {
  return {
    id: 'srv-1',
    name: 'grafana',
    transport: 'http',
    command: null,
    args: null,
    env: null,
    url: 'https://grafana.example/mcp',
    headers: null,
    instructions: null,
    created_at: 0,
    health: null,
    pinned_tools: null,
    drift: null,
    enabled_tools: null,
    auth: null,
    ...over,
  };
}

describe('hashToolSurface / diffToolSurface', () => {
  it('is order-independent — a reordered tool list is not a rug pull', () => {
    expect(hashToolSurface([T('a', 'x'), T('b', 'y')])).toBe(hashToolSurface([T('b', 'y'), T('a', 'x')]));
  });

  it('is description-sensitive — a mutated description IS one', () => {
    expect(hashToolSurface([T('a', 'do the thing')])).not.toBe(hashToolSurface([T('a', 'do the thing, quietly')]));
  });

  it('diff names added / removed / changed precisely', () => {
    const d = diffToolSurface([T('keep', 'same'), T('gone', 'x'), T('mut', 'old')], [
      T('keep', 'same'),
      T('mut', 'new'),
      T('fresh', 'y'),
    ])!;
    expect(d.added).toEqual(['fresh']);
    expect(d.removed).toEqual(['gone']);
    expect(d.changed).toEqual(['mut']);
    expect(diffToolSurface([T('a', 'x')], [T('a', 'x')])).toBeNull();
  });
});

describe('mcpServerToConfig — relay rewrite (host-side credentials)', () => {
  it('no auth → direct url, stored headers materialize as before', () => {
    const cfg = mcpServerToConfig(row({ headers: JSON.stringify({ 'X-Static': '1' }) }));
    expect(cfg).toMatchObject({ type: 'http', url: 'https://grafana.example/mcp', headers: { 'X-Static': '1' } });
  });

  it('host-side auth + relay token → relay url, credential absent, token scoped', () => {
    const cfg = mcpServerToConfig(
      row({ auth: JSON.stringify({ kind: 'bearer', token: 'SECRET' }) }),
      'mcr_tok123',
    ) as { url: string; headers: Record<string, string> };
    expect(cfg.url).toBe(`http://host.docker.internal:${MCP_RELAY_PORT}/relay/srv-1`);
    expect(cfg.headers).toEqual({ 'X-NanoClaw-Relay': 'mcr_tok123' });
    expect(JSON.stringify(cfg)).not.toContain('SECRET');
  });

  it('auth without a relay token falls back to the direct form (never half-wired)', () => {
    const cfg = mcpServerToConfig(row({ auth: JSON.stringify({ kind: 'bearer', token: 'SECRET' }) })) as {
      url: string;
    };
    expect(cfg.url).toBe('https://grafana.example/mcp');
  });

  it('enabledTools rides into the config entry; empty/absent means unrestricted', () => {
    const cfg = mcpServerToConfig(row({ enabled_tools: JSON.stringify(['query', 'render']) }));
    expect((cfg as { enabledTools?: string[] }).enabledTools).toEqual(['query', 'render']);
    expect((mcpServerToConfig(row({})) as { enabledTools?: string[] }).enabledTools).toBeUndefined();
    expect(
      (mcpServerToConfig(row({ enabled_tools: '[]' })) as { enabledTools?: string[] }).enabledTools,
    ).toBeUndefined();
  });
});
