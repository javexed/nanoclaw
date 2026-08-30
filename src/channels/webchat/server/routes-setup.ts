// ── Setup routes: onboarding, bearer token, restart, Tailscale ──────────────
// The wizard's server half plus the access controls it drives. Everything
// here mutates install-level state (env, roles, tailscale), so it's all
// csrf-guarded at the table; single-user means the authenticated caller IS
// the owner.
import { randomBytes } from 'crypto';

import { json, readJsonBody } from './http.js';
import type { RouteCtx } from '../server.js';
import { getAllWebchatRooms, getOnboardingComplete, setOnboardingComplete } from '../db.js';
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
    getAllWebchatRooms(),
    getOllamaLocalState(),
    getTailscaleServeState(),
    hasClaudeCredential(),
  ]);
  return json(res, 200, {
    complete,
    agents: agents.length,
    rooms: rooms.length,
    bearerConfigured: Boolean(process.env.WEBCHAT_TOKEN),
    claude: { connected: claudeConnected },
    ollama: { reachable: ollama.reachable, canInstall: ollama.canInstall },
    tailscale: { available: tailscale.available, active: tailscale.active, url: tailscale.url },
  });
}

export async function rOnboardingPut({ res }: RouteCtx): Promise<void> {
  await setOnboardingComplete(true);
  return json(res, 200, { ok: true });
}

/**
 * Mint a bearer token: write WEBCHAT_TOKEN (+ 0.0.0.0 bind) into .env and
 * grant `webchat:owner` the owner role NOW — once the token is live the
 * loopback auto-owner is disabled, and without the grant the operator's own
 * token would authenticate as a non-owner (a self-inflicted lockout on the
 * next restart). Takes effect after a host restart (env is read at boot).
 */
export async function rBearerGeneratePost({ res, userId }: RouteCtx): Promise<void> {
  if (process.env.WEBCHAT_TOKEN) {
    return json(res, 400, { error: 'A bearer token is already set. Remove WEBCHAT_TOKEN from .env to replace it.' });
  }
  // 24 random bytes → 32 base64url chars, comfortably over the 24-char floor.
  const token = randomBytes(24).toString('base64url');
  upsertEnv(process.cwd(), 'WEBCHAT_TOKEN', token);
  upsertEnv(process.cwd(), 'WEBCHAT_HOST', '0.0.0.0');
  try {
    await grantRole({
      user_id: 'webchat:owner',
      role: 'owner',
      agent_group_id: null,
      granted_by: userId,
      granted_at: new Date().toISOString(),
    });
  } catch {
    /* already granted — idempotent enough */
  }
  return json(res, 200, { token, restartRequired: true });
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
  const port = Number(process.env.WEBCHAT_PORT || 3100);
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
