/**
 * Grok credentials — the host owns the refresh token, the container never sees it.
 *
 * THE PROBLEM. Grok authenticates with an OIDC session: a long-lived
 * refresh_token plus a ~6h access token, both written by the CLI into
 * `~/.grok/auth.json`. Phase 3 mounts that directory read-write, because the
 * CLI needs a writable home for its session store. Left alone, that puts the
 * REFRESH token — an indefinitely renewable credential for a paid subscription
 * — inside a container where the agent executes arbitrary code.
 *
 * THE SPLIT. The refresh token stays on the host, in a directory that is
 * deliberately NOT mounted. Only a short-lived access token is materialised
 * into the container's auth.json. A leak from inside the container is then
 * bounded by that token's remaining lifetime instead of being permanent, which
 * is the whole point of the exercise.
 *
 * WHY MATERIALISE RATHER THAN SERVE. Grok supports `auth_provider_command` — a
 * shim it invokes for tokens — which would keep the credential off the
 * container filesystem entirely. That needs a host channel the container can
 * call, and upstream has none (the fork's MCP auth relay is not on this base).
 * Writing the file is the design the backlog specified and mirrors the existing
 * per-spawn materialisation pattern. `auth_provider_command` remains the
 * upgrade path the moment a channel exists; nothing here forecloses it.
 *
 * REFRESH IS ASYNC, SPAWN IS NOT. The container-config hook is synchronous, so
 * a spawn writes whatever valid token it has and kicks off a background refresh
 * when one is due. Grok documents hot-reload of auth.json ("external token
 * updates are picked up on the next API call"), so a refresh landing mid-run is
 * picked up without a restart. A 6h lifetime against sub-second spawns means
 * the synchronous path virtually always has a valid token to write.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';

/** Refresh this far before actual expiry — never hand out a token about to die. */
export const REFRESH_SKEW_MS = 10 * 60_000;

/**
 * How often the host checks whether a credential is due.
 *
 * MUST be shorter than REFRESH_SKEW_MS, and a test enforces it. The first cut
 * was 15 minutes against a 10-minute skew, which leaves a hole: a token with 11
 * minutes left is not due at one tick and is already expired by the next. The
 * tick has to be able to catch a credential inside its own warning window.
 * A tick that finds nothing due costs one small file read.
 */
export const REFRESH_TICK_MS = 5 * 60_000;

/** xAI's OIDC token endpoint, from its published discovery document. */
export const DEFAULT_TOKEN_ENDPOINT = 'https://auth.x.ai/oauth2/token';

export interface GrokCredentials {
  accessToken: string;
  refreshToken: string;
  /** ISO-8601 UTC, per the repo's timestamp rule. */
  expiresAt: string;
  issuer: string;
  clientId: string;
  /** Carried through to the container file for parity with the CLI's own shape. */
  email?: string;
  userId?: string;
  /**
   * The CLI's `create_time` for this session.
   *
   * Not decoration — MEASURED as required: a container auth.json missing
   * `create_time` (or `user_id`, or `auth_mode`) reads as "You are not
   * authenticated" even when the access token is perfectly valid. Carried from
   * the CLI's own file so the value we hand back is the one it minted.
   */
  createdAt?: string;
}

/**
 * Install-wide credentials, used by every group that has no override.
 *
 * One xAI subscription is the normal case, and making each agent group repeat
 * a device login would be busywork that also multiplies the number of live
 * refresh tokens on disk. A per-group file still wins when present, which is
 * what a second subscription (or a deliberately separated identity) needs.
 */
export function sharedCredentialsPath(): string {
  return path.join(DATA_DIR, 'grok', 'credentials.json');
}

export function writeSharedCredentials(creds: GrokCredentials): void {
  const dir = path.dirname(sharedCredentialsPath());
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(sharedCredentialsPath(), JSON.stringify(creds, null, 2), { mode: 0o600 });
  fs.chmodSync(sharedCredentialsPath(), 0o600);
}

/** Host-only credential directory. NOT the mounted `.grok-shared`. */
export function grokHostDir(agentGroupId: string): string {
  return path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.grok-host');
}

export function hostCredentialsPath(agentGroupId: string): string {
  return path.join(grokHostDir(agentGroupId), 'credentials.json');
}

function readCredentialFile(file: string): GrokCredentials | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as GrokCredentials;
  } catch {
    // A corrupt credential file must not crash a spawn; the agent falls back to
    // whatever is already in the container and the operator re-authenticates.
    return null;
  }
}

/** Per-group credentials when present, otherwise the install-wide ones. */
export function readHostCredentials(agentGroupId: string): GrokCredentials | null {
  return readCredentialFile(hostCredentialsPath(agentGroupId)) ?? readCredentialFile(sharedCredentialsPath());
}

export function writeHostCredentials(agentGroupId: string, creds: GrokCredentials): void {
  const dir = grokHostDir(agentGroupId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = hostCredentialsPath(agentGroupId);
  fs.writeFileSync(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** True when the access token is expired or close enough that it should be renewed. */
export function needsRefresh(creds: GrokCredentials, now: number = Date.now()): boolean {
  const expiry = Date.parse(creds.expiresAt);
  if (Number.isNaN(expiry)) return true; // unparseable expiry — treat as due
  return expiry - now <= REFRESH_SKEW_MS;
}

export interface RefreshDeps {
  fetchFn?: typeof fetch;
  tokenEndpoint?: string;
  now?: () => number;
}

/**
 * Exchange the refresh token for a new access token.
 *
 * A public client (xAI publishes `none` among its auth methods), so no secret
 * is sent. A rotated refresh_token in the response REPLACES the stored one —
 * dropping it would strand the group at the old token's expiry.
 */
export async function refreshCredentials(creds: GrokCredentials, deps: RefreshDeps = {}): Promise<GrokCredentials> {
  const doFetch = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  const endpoint = deps.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT;

  const res = await doFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: creds.clientId,
    }).toString(),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`grok token refresh failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }

  const payload = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!payload.access_token) throw new Error('grok token refresh returned no access_token');

  const lifetimeMs = (payload.expires_in ?? 3600) * 1000;
  return {
    ...creds,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? creds.refreshToken,
    expiresAt: new Date(now() + lifetimeMs).toISOString(),
  };
}

/**
 * The container-visible auth.json, in the CLI's own shape but WITHOUT the
 * refresh token. Keyed `<issuer>::<clientId>`, which is how the CLI indexes it.
 *
 * THE REQUIRED SET WAS MEASURED, not guessed, by dropping one field at a time
 * from a known-good file and asking the CLI whether it was still signed in:
 * `key`, `auth_mode`, `create_time`, `user_id`, `expires_at` and the two oidc_*
 * fields are required; `refresh_token`, `email` and `principal_*` are not.
 * That `refresh_token` is optional is what makes this whole split possible —
 * the container is authenticated without ever holding the renewable credential.
 */
export function containerAuthJson(creds: GrokCredentials): Record<string, unknown> {
  return {
    [`${creds.issuer}::${creds.clientId}`]: {
      key: creds.accessToken,
      auth_mode: 'oidc',
      create_time: creds.createdAt ?? new Date().toISOString(),
      expires_at: creds.expiresAt,
      oidc_issuer: creds.issuer,
      oidc_client_id: creds.clientId,
      ...(creds.email ? { email: creds.email } : {}),
      ...(creds.userId ? { user_id: creds.userId, principal_id: creds.userId, principal_type: 'User' } : {}),
    },
  };
}

/** Write the access-token-only auth.json into the mounted grok home. */
export function writeContainerAuth(grokSharedPath: string, creds: GrokCredentials): void {
  fs.mkdirSync(grokSharedPath, { recursive: true, mode: 0o700 });
  const file = path.join(grokSharedPath, 'auth.json');
  fs.writeFileSync(file, JSON.stringify(containerAuthJson(creds), null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/**
 * Split a CLI-written auth.json (the artefact of `grok login --device-auth`)
 * into host and container halves. This is how a fresh device login becomes
 * managed credentials — Phase 5's walk-through ends here.
 */
export function importCliAuthJson(raw: Record<string, unknown>): GrokCredentials | null {
  for (const [key, value] of Object.entries(raw)) {
    const entry = value as Record<string, unknown>;
    if (typeof entry?.key !== 'string' || typeof entry?.refresh_token !== 'string') continue;
    const [issuer, clientId] = key.split('::');
    return {
      accessToken: entry.key,
      refreshToken: entry.refresh_token,
      expiresAt: typeof entry.expires_at === 'string' ? entry.expires_at : new Date().toISOString(),
      issuer: typeof entry.oidc_issuer === 'string' ? entry.oidc_issuer : (issuer ?? ''),
      clientId: typeof entry.oidc_client_id === 'string' ? entry.oidc_client_id : (clientId ?? ''),
      ...(typeof entry.email === 'string' ? { email: entry.email } : {}),
      ...(typeof entry.user_id === 'string' ? { userId: entry.user_id } : {}),
      ...(typeof entry.create_time === 'string' ? { createdAt: entry.create_time } : {}),
    };
  }
  return null;
}

/**
 * Spawn-time credential materialisation. Synchronous by necessity (the
 * container-config hook is), so: write the token we have, and schedule a
 * refresh when one is due. Returns false when there is nothing to write, which
 * is the un-authenticated case, not an error.
 */
export function materializeContainerAuth(
  agentGroupId: string,
  grokSharedPath: string,
  deps: RefreshDeps & { onError?: (err: unknown) => void } = {},
): boolean {
  const creds = readHostCredentials(agentGroupId);
  if (!creds) return false;
  // Write a refresh back to whichever file it came from: persisting a rotated
  // token to the per-group path when it was read from the shared one would
  // silently fork the identity and leave the shared file stale.
  const persist = fs.existsSync(hostCredentialsPath(agentGroupId))
    ? (next: GrokCredentials) => writeHostCredentials(agentGroupId, next)
    : writeSharedCredentials;

  writeContainerAuth(grokSharedPath, creds);

  if (needsRefresh(creds, (deps.now ?? Date.now)())) {
    // Background: the spawn must not wait on a network round-trip, and Grok
    // hot-reloads auth.json when the fresher token lands.
    void refreshCredentials(creds, deps)
      .then((next) => {
        persist(next);
        writeContainerAuth(grokSharedPath, next);
      })
      .catch((err) => deps.onError?.(err));
  }
  return true;
}

/** Every credential file this install owns: the shared one, plus any per-group overrides. */
export function listCredentialOwners(): Array<{ label: string; read: () => GrokCredentials | null; write: (c: GrokCredentials) => void }> {
  const owners: Array<{ label: string; read: () => GrokCredentials | null; write: (c: GrokCredentials) => void }> = [
    { label: 'shared', read: () => readCredentialFile(sharedCredentialsPath()), write: writeSharedCredentials },
  ];
  const root = path.join(DATA_DIR, 'v2-sessions');
  let groups: string[] = [];
  try {
    groups = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return owners; // no sessions dir yet — the shared credential is all there is
  }
  for (const id of groups) {
    if (!fs.existsSync(hostCredentialsPath(id))) continue;
    owners.push({
      label: `group ${id}`,
      read: () => readCredentialFile(hostCredentialsPath(id)),
      write: (c: GrokCredentials) => writeHostCredentials(id, c),
    });
  }
  return owners;
}

export interface RefreshSweepDeps extends RefreshDeps {
  onInfo?: (message: string) => void;
  onError?: (message: string) => void;
}

/**
 * Renew every credential that is due. Returns how many were refreshed.
 *
 * WHY THIS EXISTS AT ALL. Until now the only thing that ever refreshed a token
 * was a container SPAWN. A Grok token lives 6h, so an install whose Grok agents
 * sat idle overnight woke to an expired credential, a wizard card reading "not
 * connected", and a first turn that had to race a background refresh to succeed.
 * Observed exactly that. Expiry is a function of TIME, so the thing that renews
 * it has to be too.
 *
 * Failures are per-credential and never thrown: one group's dead refresh token
 * must not stop another group's from being renewed, and a network blip should
 * cost a retry on the next tick, not the sweep.
 */
export async function refreshDueCredentials(deps: RefreshSweepDeps = {}): Promise<number> {
  const now = (deps.now ?? Date.now)();
  let refreshed = 0;
  for (const owner of listCredentialOwners()) {
    const creds = owner.read();
    if (!creds || !needsRefresh(creds, now)) continue;
    try {
      const next = await refreshCredentials(creds, deps);
      owner.write(next);
      refreshed += 1;
      deps.onInfo?.(`Grok credential renewed (${owner.label}) — valid until ${next.expiresAt}`);
    } catch (err) {
      deps.onError?.(
        `Grok credential refresh failed (${owner.label}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return refreshed;
}

/**
 * Start the periodic sweep. Returns a stop function.
 *
 * The timer is unref'd so it never keeps the host alive on its own, and the
 * first sweep runs immediately: a host that has just started after being down
 * for hours is exactly the case where a credential is already stale.
 */
export function startGrokCredentialRefresh(deps: RefreshSweepDeps = {}): () => void {
  const tick = () => void refreshDueCredentials(deps);
  tick();
  const timer = setInterval(tick, REFRESH_TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
