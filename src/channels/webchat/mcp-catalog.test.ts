/**
 * MCP catalog normalizer.
 *
 * The security-relevant bit is `runsCode`: a *remote* entry means the container
 * dials out to a hosted URL, while a *package* entry means third-party npm/pypi
 * code executes INSIDE the agent container next to its credentials. The UI gates
 * on this flag, so getting it wrong is not cosmetic.
 *
 * There is deliberately no "official" tier: nothing in the registry is published by
 * Anthropic, and trusting a name match would be worse than useless — third parties
 * publish servers *called* things like `anthropic-admin-mcp`.
 */
import { describe, expect, it } from 'vitest';
import { normalizeMcpRegistry, safeHttpUrl } from './server.js';

const payload = (servers: unknown[]) => ({ servers: servers.map((server) => ({ server })) });

describe('normalizeMcpRegistry', () => {
  it('maps a remote server and marks it as NOT running local code', () => {
    const [row] = normalizeMcpRegistry(
      payload([
        {
          name: 'ac.tandem/docs-mcp',
          description: 'Docs',
          version: '0.3.0',
          remotes: [{ type: 'streamable-http', url: 'https://tandem.ac/mcp' }],
        },
      ]),
    );
    expect(row.kind).toBe('remote');
    expect(row.runsCode).toBe(false);
    expect(row.url).toBe('https://tandem.ac/mcp');
    expect(row.transport).toBe('http'); // streamable-http → our 'http'
    expect(row.publisher).toBe('ac.tandem');
  });

  it('maps sse remotes to the sse transport', () => {
    const [row] = normalizeMcpRegistry(
      payload([{ name: 'x/y', version: '1.0.0', remotes: [{ type: 'sse', url: 'https://e.x/sse' }] }]),
    );
    expect(row.transport).toBe('sse');
  });

  it('flags npm/pypi packages as running code in the container', () => {
    const rows = normalizeMcpRegistry(
      payload([
        { name: 'a/npm-one', version: '1.0.0', packages: [{ registryType: 'npm', identifier: 'some-mcp' }] },
        { name: 'b/py-one', version: '1.0.0', packages: [{ registryType: 'pypi', identifier: 'py-mcp' }] },
      ]),
    );
    const npm = rows.find((r) => r.name === 'a/npm-one')!;
    const py = rows.find((r) => r.name === 'b/py-one')!;
    expect(npm.kind).toBe('package');
    expect(npm.runsCode).toBe(true);
    expect(npm.command).toBe('npx');
    // Pinned to the entry's immutable version — an unpinned command would
    // re-resolve LATEST at every container spawn (the rug-pull window).
    expect(npm.args).toEqual(['-y', 'some-mcp@1.0.0']);
    expect(py.command).toBe('uvx');
    expect(py.args).toEqual(['py-mcp==1.0.0']);
  });

  it('does not pin junk version strings — a bad pin would break the install', () => {
    const [row] = normalizeMcpRegistry(
      payload([{ name: 'a/weird', version: 'latest-greatest', packages: [{ registryType: 'npm', identifier: 'w' }] }]),
    );
    expect(row.args).toEqual(['-y', 'w']);
  });

  it('prefers the remote form when a server offers both — the safe one wins', () => {
    const [row] = normalizeMcpRegistry(
      payload([
        {
          name: 'both/ways',
          version: '1.0.0',
          remotes: [{ type: 'streamable-http', url: 'https://both.example/mcp' }],
          packages: [{ registryType: 'npm', identifier: 'both-mcp' }],
        },
      ]),
    );
    expect(row.kind).toBe('remote');
    expect(row.runsCode).toBe(false);
  });

  it('dedupes repeated names, keeping the newest version (numerically, not by string)', () => {
    const rows = normalizeMcpRegistry(
      payload([
        { name: 'dup/server', version: '1.9.0', remotes: [{ type: 'streamable-http', url: 'https://old' }] },
        { name: 'dup/server', version: '1.10.0', remotes: [{ type: 'streamable-http', url: 'https://new' }] },
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe('1.10.0'); // string sort would have picked 1.9.0
    expect(rows[0].url).toBe('https://new');
  });

  it('skips entries we cannot run or reach (oci, or neither remote nor package)', () => {
    const rows = normalizeMcpRegistry(
      payload([
        { name: 'oci/thing', version: '1.0.0', packages: [{ registryType: 'oci', identifier: 'img:tag' }] },
        { name: 'empty/thing', version: '1.0.0' },
        { version: '1.0.0' }, // no name at all
      ]),
    );
    expect(rows).toEqual([]);
  });
});

describe('safeHttpUrl — registry data reaches an <a href>', () => {
  it('passes http(s) through', () => {
    expect(safeHttpUrl('https://github.com/foo/bar')).toBe('https://github.com/foo/bar');
    expect(safeHttpUrl('http://example.com/')).toBe('http://example.com/');
  });

  it('rejects anything that could execute or smuggle content', () => {
    // A registry entry is third-party data — it must not be able to put a
    // javascript:/data: URL into a link the operator is invited to click.
    expect(safeHttpUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeHttpUrl('data:text/html,<script>alert(1)</script>')).toBeUndefined();
    expect(safeHttpUrl('file:///etc/passwd')).toBeUndefined();
    expect(safeHttpUrl('not a url')).toBeUndefined();
    expect(safeHttpUrl(undefined)).toBeUndefined();
    expect(safeHttpUrl(42)).toBeUndefined();
  });
});

describe('provenance links on catalog rows', () => {
  it('carries the repository url so the badge can link to readable source', () => {
    const [row] = normalizeMcpRegistry({
      servers: [
        {
          server: {
            name: 'ac.tandem/docs-mcp',
            version: '1.0.0',
            repository: { url: 'https://github.com/frumu-ai/tandem', source: 'github' },
            websiteUrl: 'https://tandem.ac/docs-mcp',
            remotes: [{ type: 'streamable-http', url: 'https://tandem.ac/mcp' }],
          },
        },
      ],
    });
    expect(row.repoUrl).toBe('https://github.com/frumu-ai/tandem');
    expect(row.websiteUrl).toBe('https://tandem.ac/docs-mcp');
  });

  it('drops a hostile repository url rather than passing it to the UI', () => {
    const [row] = normalizeMcpRegistry({
      servers: [
        {
          server: {
            name: 'evil/one',
            version: '1.0.0',
            repository: { url: 'javascript:alert(document.cookie)' },
            remotes: [{ type: 'streamable-http', url: 'https://ok.example/mcp' }],
          },
        },
      ],
    });
    expect(row.repoUrl).toBeUndefined();
  });
});
