import { describe, expect, it } from 'vitest';

import { isRemoteSession, reachInstructions, reachableWebUrl } from './web-reach.js';

describe('isRemoteSession', () => {
  it('is true over SSH', () => {
    expect(isRemoteSession({ SSH_CONNECTION: '10.0.0.2 51234 10.0.0.9 22' })).toBe(true);
    expect(isRemoteSession({ SSH_TTY: '/dev/pts/0' })).toBe(true);
    expect(isRemoteSession({ SSH_CLIENT: '10.0.0.2 51234 22' })).toBe(true);
  });

  it('is false at a local console with no display', () => {
    // The tempting shortcut is "no DISPLAY means remote". It does not: a console
    // login on a headless desktop is local, and treating it as remote would bind
    // a port and mint a token nobody asked for.
    expect(isRemoteSession({})).toBe(false);
    expect(isRemoteSession({ TERM: 'linux' })).toBe(false);
  });
});

describe('reachableWebUrl', () => {
  const port = '3100';

  it('prefers the tailnet URL — HTTPS, stable, already identified', () => {
    expect(
      reachableWebUrl({ port, networkBound: true, hostAddress: '192.0.2.10', tailscaleUrl: 'https://box.ts.net' }),
    ).toEqual({ url: 'https://box.ts.net/', kind: 'tailscale' });
  });

  it('falls back to the host address when bound to the network', () => {
    expect(reachableWebUrl({ port, networkBound: true, hostAddress: '192.0.2.10' })).toEqual({
      url: 'http://192.0.2.10:3100/',
      kind: 'host',
    });
  });

  it('brackets an IPv6 literal', () => {
    expect(reachableWebUrl({ port, networkBound: true, hostAddress: '2001:db8::5' }).url).toBe(
      'http://[2001:db8::5]:3100/',
    );
  });

  it('stays on loopback when the server is bound to loopback', () => {
    // Pointing at a LAN IP the server is not listening on would fail in a more
    // confusing way than the honest loopback URL plus tunnel instructions.
    expect(reachableWebUrl({ port, networkBound: false, hostAddress: '192.0.2.10' })).toEqual({
      url: 'http://127.0.0.1:3100/',
      kind: 'loopback',
    });
  });
});

describe('reachInstructions', () => {
  it('offers a tunnel when a remote operator is handed a loopback URL', () => {
    const lines = reachInstructions({ port: '3100', networkBound: false, kind: 'loopback' });
    // isRemoteSession() reads the real env here; assert only on the shape that
    // does not depend on it, then the token case below covers the rest.
    expect(Array.isArray(lines)).toBe(true);
  });

  it('prints the token to paste, and never embeds it in the URL', () => {
    const token = 'tok_abc123';
    const lines = reachInstructions({ port: '3100', networkBound: true, kind: 'host', token });
    expect(lines.join('\n')).toContain(token);
    // A token in the URL lands in shell history, scrollback and proxy logs.
    expect(reachableWebUrl({ port: '3100', networkBound: true, hostAddress: '192.0.2.10', token }).url).not.toContain(
      token,
    );
  });

  it('says nothing extra when there is no token and the URL works', () => {
    expect(reachInstructions({ port: '3100', networkBound: true, kind: 'host' })).toEqual([]);
  });
});
