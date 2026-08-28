/**
 * Host-side container config for the `opencode` provider.
 *
 * OpenCode's `opencode serve` process stores state under XDG_DATA_HOME, which
 * we pin to a per-session host directory mounted at /opencode-xdg. The
 * OPENCODE_* env vars tell the CLI which provider/model to use at runtime
 * (read on the host, injected into the container). NO_PROXY / no_proxy are
 * merged with host values so the in-container OpenCode client can talk to
 * 127.0.0.1 even when HTTPS_PROXY is set by OneCLI.
 */
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

// Per-agent OpenCode model, written by the webchat model bridge
// (writeLocalModelForAgent) at
// <DATA_DIR>/v2-sessions/<agentGroupId>/.claude-shared/local-model.json.
// This is the source of truth when present: it wires the harness to the exact
// local model the agent is assigned in the webchat UI, so installing OpenCode
// "just works" for local models — no global .env editing, no manual switch.
// Absent/unreadable → fall back to .env (manual or cloud-backend setups).
//
// ctx.sessionDir is <…>/v2-sessions/<agentGroupId>/<sessionId>, and .claude-shared
// is a sibling of the session dir — one level up — so it's `../.claude-shared`
// (the agentGroupId is already in the path; don't append it again).
//
// Reads BOTH names, new first: this file was `opencode-model.json` when OpenCode
// was its only reader, and is `local-model.json` now that pi reads it too. An
// install whose file predates the rename still resolves; the host writes only
// the new name and removes the old one, so the fallback cannot shadow current
// wiring.
function readAgentModel(ctx: { sessionDir: string }): Record<string, string> {
  const shared = path.join(ctx.sessionDir, '..', '.claude-shared');
  for (const name of ['local-model.json', 'opencode-model.json']) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(shared, name), 'utf-8')) as {
        provider?: string;
        model?: string;
        smallModel?: string;
        baseURL?: string;
      };
      const out: Record<string, string> = {};
      if (cfg.provider) out.OPENCODE_PROVIDER = cfg.provider;
      if (cfg.model) out.OPENCODE_MODEL = cfg.model;
      if (cfg.smallModel) out.OPENCODE_SMALL_MODEL = cfg.smallModel;
      if (cfg.baseURL) out.ANTHROPIC_BASE_URL = cfg.baseURL;
      return out;
    } catch {
      // absent or unreadable — try the next name, then give up silently.
    }
  }
  return {};
}

function mergeNoProxy(current: string | undefined, additions: string): string {
  if (!current?.trim()) return additions;
  const parts = new Set(
    current
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const addition of additions.split(',')) {
    const trimmed = addition.trim();
    if (trimmed) parts.add(trimmed);
  }
  return [...parts].join(',');
}

registerProviderContainerConfig('opencode', (ctx) => {
  const opencodeDir = path.join(ctx.sessionDir, 'opencode-xdg');
  fs.mkdirSync(opencodeDir, { recursive: true });

  // Precedence: per-agent model (webchat UI, written per group) → .env → process.env.
  // .env is NOT loaded into process.env on this install (the webchat server reads it
  // directly), so read it straight — same pattern as the claude provider.
  const perAgent = readAgentModel(ctx);
  const dotenv = readEnvFile(['OPENCODE_PROVIDER', 'OPENCODE_MODEL', 'OPENCODE_SMALL_MODEL', 'ANTHROPIC_BASE_URL']);
  const pick = (k: string): string | undefined => perAgent[k] || dotenv[k] || ctx.hostEnv[k];

  const env: Record<string, string> = {
    XDG_DATA_HOME: '/opencode-xdg',
    // host.docker.internal is added so a LOCAL provider (Ollama on the host) is
    // reached DIRECTLY, bypassing the OneCLI HTTPS_PROXY — cloud providers still
    // proxy normally since their hostnames aren't in this list.
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, '127.0.0.1,localhost,host.docker.internal'),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, '127.0.0.1,localhost,host.docker.internal'),
  };
  for (const key of ['OPENCODE_PROVIDER', 'OPENCODE_MODEL', 'OPENCODE_SMALL_MODEL', 'ANTHROPIC_BASE_URL'] as const) {
    const value = pick(key);
    if (value) env[key] = value;
  }

  return {
    mounts: [{ hostPath: opencodeDir, containerPath: '/opencode-xdg', readonly: false }],
    env,
  };
});
