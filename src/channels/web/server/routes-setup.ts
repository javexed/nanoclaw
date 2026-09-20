// ── Setup routes: onboarding, bearer token, restart, Tailscale ──────────────
// The wizard's server half plus the access controls it drives. Everything
// here mutates install-level state (env, roles, tailscale), so it's all
// csrf-guarded at the table; single-user means the authenticated caller IS
// the owner.
import { randomBytes } from 'crypto';

import { json, readJsonBody } from './http.js';
import type { RouteCtx } from '../server.js';
import { getAllWebRooms, getOnboardingComplete, setOnboardingComplete } from '../db.js';
import { getAllAgentGroups } from '../../../db/agent-groups.js';
import { grantRole } from '../../../modules/permissions/db/user-roles.js';
import {
  getOllamaLocalState,
  getTailscaleInstallState,
  startTailscaleInstall,
  scheduleHostRestart,
  upsertEnv,
} from '../ollama-manage.js';
import { enableTailscaleServe, getTailscaleServeState } from '../tailscale-serve.js';
import { getOpencodeInstallState, startOpencodeInstall } from '../opencode-manage.js';
import {
  cancelClaudeSignin,
  finishClaudeSignin,
  hasClaudeCredential,
  startClaudeSignin,
  storeClaudeCredential,
} from '../claude-auth.js';

async function parseBody<T>(ctx: RouteCtx): Promise<T | null> {
  const raw = await readJsonBody(ctx.req, ctx.res);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    json(ctx.res, 400, { error: 'Invalid JSON' });
    return null;
  }
}

/** Wizard state: what's done, what the environment offers. */
export async function rOnboardingGet({ res }: RouteCtx): Promise<void> {
  const [complete, agents, rooms, ollama, tailscale, claudeConnected] = await Promise.all([
    getOnboardingComplete(),
    getAllAgentGroups(),
    getAllWebRooms(),
    getOllamaLocalState(),
    getTailscaleServeState(),
    hasClaudeCredential(),
  ]);
  const opencode = getOpencodeInstallState();
  return json(res, 200, {
    complete,
    agents: agents.length,
    rooms: rooms.length,
    bearerConfigured: Boolean(process.env.WEB_TOKEN),
    claude: { connected: claudeConnected },
    ollama: { reachable: ollama.reachable, canInstall: ollama.canInstall },
    // The harness a local model runs on. Reported because without it, picking a
    // local model changes nothing about inference (models.ts: a non-anthropic
    // kind with no OpenCode yields no env at all) — and the wizard used to give
    // no hint that anything was missing.
    opencode: { installed: opencode.installed, canInstall: opencode.canInstall, reason: opencode.reason },
    tailscale: { available: tailscale.available, active: tailscale.active, url: tailscale.url },
  });
}

export async function rOnboardingPut({ res }: RouteCtx): Promise<void> {
  await setOnboardingComplete(true);
  return json(res, 200, { ok: true });
}

/**
 * Mint a bearer token: write WEB_TOKEN (+ 0.0.0.0 bind) into .env and
 * grant `web:owner` the owner role NOW — once the token is live the
 * loopback auto-owner is disabled, and without the grant the operator's own
 * token would authenticate as a non-owner (a self-inflicted lockout on the
 * next restart). Takes effect after a host restart (env is read at boot).
 */
export async function rBearerGeneratePost({ res, userId }: RouteCtx): Promise<void> {
  if (process.env.WEB_TOKEN) {
    return json(res, 400, { error: 'A bearer token is already set. Remove WEB_TOKEN from .env to replace it.' });
  }
  // 24 random bytes → 32 base64url chars, comfortably over the 24-char floor.
  const token = randomBytes(24).toString('base64url');
  upsertEnv(process.cwd(), 'WEB_TOKEN', token);
  // A token only matters if the port is reachable — opening the bind is the
  // point. This is disclosed in the response so the UI can warn, not silent.
  upsertEnv(process.cwd(), 'WEB_HOST', '0.0.0.0');
  try {
    await grantRole({
      user_id: 'web:owner',
      role: 'owner',
      agent_group_id: null,
      granted_by: userId,
      granted_at: new Date().toISOString(),
    });
  } catch {
    /* already granted — idempotent enough */
  }
  return json(res, 200, { token, restartRequired: true, bindsAllInterfaces: true });
}

/**
 * Restart the host to load a freshly-written .env. Detached (systemd-run /
 * launchctl), so the response flushes before the process goes down; the
 * client reconnects on its own.
 */
export async function rRestartPost({ res }: RouteCtx): Promise<void> {
  scheduleHostRestart();
  return json(res, 202, { restarting: true });
}

// ── Tailscale ───────────────────────────────────────────────────────────────

export async function rTailscaleHttpsGet({ res }: RouteCtx): Promise<void> {
  return json(res, 200, await getTailscaleServeState());
}

export async function rTailscaleHttpsPost({ res }: RouteCtx): Promise<void> {
  const port = Number(process.env.WEB_PORT || 3100);
  const result = await enableTailscaleServe(port);
  return json(res, result.ok ? 200 : 502, result);
}

export async function rTailscaleInstallGet({ res }: RouteCtx): Promise<void> {
  return json(res, 200, getTailscaleInstallState());
}

export async function rTailscaleInstallPost({ res }: RouteCtx): Promise<void> {
  const result = startTailscaleInstall();
  return json(res, result.started ? 202 : 409, result);
}

// ── Claude sign-in (browser mint of the install credential) ─────────────────

export async function rClaudeAuthStartPost(ctx: RouteCtx): Promise<void> {
  try {
    return json(ctx.res, 200, await startClaudeSignin());
  } catch (err) {
    return json(ctx.res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function rClaudeAuthCodePost(ctx: RouteCtx): Promise<void> {
  const body = await parseBody<{ sessionId?: unknown; code?: unknown }>(ctx);
  if (!body) return;
  if (typeof body.sessionId !== 'string' || typeof body.code !== 'string' || !body.code.trim()) {
    return json(ctx.res, 400, { error: 'sessionId and code required' });
  }
  try {
    const token = await finishClaudeSignin(body.sessionId, body.code);
    await storeClaudeCredential(token);
    return json(ctx.res, 200, { ok: true });
  } catch (err) {
    return json(ctx.res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function rClaudeAuthCancelPost(ctx: RouteCtx): Promise<void> {
  const body = await parseBody<{ sessionId?: unknown }>(ctx);
  if (!body) return;
  if (typeof body.sessionId === 'string') cancelClaudeSignin(body.sessionId);
  return json(ctx.res, 200, { ok: true });
}

/** Harness state + the streamed log of an install in flight. */
export function rOpencodeGet({ res }: RouteCtx): void {
  const state = getOpencodeInstallState();
  json(res, 200, {
    installed: state.installed,
    canInstall: state.canInstall,
    reason: state.reason,
    running: state.running,
    lines: state.lines,
    exitCode: state.exitCode,
  });
}

/**
 * Start the install. Returns immediately — this rebuilds the host, rebuilds the
 * agent image and restarts the service, so the client polls rOpencodeGet for
 * progress the same way it does for Ollama.
 */
export function rOpencodeInstallPost({ res }: RouteCtx): void {
  const started = startOpencodeInstall();
  if (!started.started) return json(res, 409, { error: started.error ?? 'could not start' });
  json(res, 202, { started: true });
}
