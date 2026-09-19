/**
 * Where the operator can actually reach the web UI, and whether setup should
 * offer to open it up.
 *
 * The hand-off used to print `http://127.0.0.1:<port>/` unconditionally. On the
 * machine you are sitting at that is right. Over SSH it is the one URL that
 * cannot work: it names the server's own loopback, for a server that setup has
 * just bound to loopback only, with no token — so the operator is handed an
 * address their browser cannot reach, for a UI they cannot authenticate to, and
 * the in-app wizard that would fix both is behind that same unreachable URL.
 *
 * `deploy/web-deploy.sh` has always got this right for headless installs: it
 * binds the network, mints a bearer token and prints `http://<this-host>:<port>/`
 * with the token. This module is that behaviour for the interactive path.
 *
 * Everything here is pure and injectable so the decisions are testable without
 * a network, a tailnet, or an SSH session.
 */

/** Is setup running against a machine the operator is NOT sitting at? */
export function isRemoteSession(env: NodeJS.ProcessEnv = process.env): boolean {
  // SSH_CONNECTION/SSH_TTY are the strong signal and the common case: they say
  // "the terminal is elsewhere" outright. A bare missing DISPLAY is NOT enough
  // on its own — a local console login on a server with no X is not remote, and
  // treating it as remote would open a port nobody asked to open.
  return Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);
}

export interface ReachOptions {
  port: string;
  /** Bearer token, when one is configured. Changes the instructions, not the URL. */
  token?: string | null;
  /** HTTPS URL from `tailscale serve`, when the tailnet is up. */
  tailscaleUrl?: string | null;
  /** Routable address of this host, e.g. a LAN IP. */
  hostAddress?: string | null;
  /** Whether the server is bound beyond loopback. */
  networkBound: boolean;
}

/**
 * The best URL to hand the operator, and why.
 *
 * Order is deliberate: a tailnet URL beats a LAN IP because it is HTTPS,
 * stable, and already authenticated by tailscale's own identity; a LAN IP beats
 * loopback because loopback is unusable from anywhere else. Loopback is the
 * honest answer when the server is bound to it — pointing elsewhere would just
 * fail differently.
 */
export function reachableWebUrl(opts: ReachOptions): { url: string; kind: 'tailscale' | 'host' | 'loopback' } {
  if (opts.tailscaleUrl) {
    const base = opts.tailscaleUrl.replace(/\/+$/, '');
    return { url: `${base}/`, kind: 'tailscale' };
  }
  if (opts.networkBound && opts.hostAddress) {
    return { url: `http://${formatHost(opts.hostAddress)}:${opts.port}/`, kind: 'host' };
  }
  return { url: `http://127.0.0.1:${opts.port}/`, kind: 'loopback' };
}

/** IPv6 literals need brackets in a URL; everything else is passed through. */
function formatHost(address: string): string {
  return address.includes(':') ? `[${address}]` : address;
}

/**
 * What to tell the operator alongside the URL. A token has to be pasted at
 * first login — deliberately NOT embedded in the URL, which would put the
 * secret into shell history, terminal scrollback and any proxy log in between.
 */
export function reachInstructions(opts: ReachOptions & { kind: 'tailscale' | 'host' | 'loopback' }): string[] {
  const lines: string[] = [];
  if (opts.kind === 'loopback' && isRemoteSession()) {
    lines.push(
      'This address only works ON that machine. To reach it from here, forward the port:',
      `  ssh -L ${opts.port}:127.0.0.1:${opts.port} <user>@<this-host>`,
    );
  }
  if (opts.token) {
    lines.push('Paste this token at first login — the first login becomes the owner:', `  ${opts.token}`);
  }
  return lines;
}
