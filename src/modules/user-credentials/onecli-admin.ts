/**
 * Thin wrapper over the `onecli` CLI for UserCreds onboarding (the SDK has no secret
 * management). The CLI reads ONECLI_URL/ONECLI_API_KEY from the host env, same
 * as the SDK. Isolated behind an interface so onboarding orchestration is
 * testable with a fake and the real CLI shapes live in one place.
 *
 * JSON shapes confirmed against onecli 1.2.x:
 *   agents list   → { data: [{ id, identifier, secretMode, ... }] }
 *   secrets list  → { data: [{ id, type, hostPattern, ... }] }
 *   agents secrets --id → { data: [{ id, type, hostPattern, ... }] }
 *   secrets create / agents create → the created row (id) under data
 *
 * NOTE: `secrets create --value <secret>` passes the value in argv (briefly
 * visible in the host process list) — this covers API keys AND Claude OAuth
 * subscription tokens (both go via --value; only Codex auth.json uses --file).
 * onecli has no stdin value input as of 1.2.x; the host is single-user so the
 * exposure window is small — documented residual.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { UserCredsCredType } from './db.js';
import { writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';

const pexec = promisify(execFile);
const TIMEOUT_MS = 20_000;

/**
 * Run `fn` with a path to a 0600 temp file holding `content`, then shred it.
 * Used for Codex OAuth credentials — the whole `auth.json` is too large/sensitive
 * to pass via `--value` (which lands in argv / the host process list); onecli's
 * `secrets create/update --file` reads it off disk instead.
 */
async function withSecretFile<T>(content: string, fn: (path: string) => Promise<T>): Promise<T> {
  const path = join(tmpdir(), `user-creds-${randomBytes(12).toString('hex')}.json`);
  writeFileSync(path, content, { mode: 0o600 });
  try {
    return await fn(path);
  } finally {
    rmSync(path, { force: true });
  }
}

async function onecli(args: string[]): Promise<unknown> {
  try {
    const { stdout } = await pexec('onecli', args, { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim() ? (JSON.parse(stdout) as unknown) : {};
  } catch (err) {
    // execFile rejections carry the full argv (incl. any `--value <secret>`) on
    // `.message`/`.cmd`; those propagate to callers that log err.message and would
    // leak a member's plaintext key into the persistent host log. Rethrow a scrubbed
    // error that names only the resource+verb (args[0]/args[1] are never secrets) and
    // the exit code — never the argv. See user-creds-adversarial-review (cred-storage).
    const code = (err as { code?: unknown } | null)?.code;
    throw new Error(`onecli ${args[0] ?? '?'} ${args[1] ?? ''}`.trim() + ` failed (exit ${code ?? '?'})`);
  }
}

function dataArray(r: unknown): Record<string, unknown>[] {
  const d = (r as { data?: unknown })?.data;
  if (Array.isArray(d)) return d as Record<string, unknown>[];
  if (d && typeof d === 'object') return [d as Record<string, unknown>];
  return [];
}
function createdId(r: unknown): string | null {
  const d = (r as { data?: unknown; id?: unknown })?.data;
  if (Array.isArray(d)) return (d[0] as { id?: string })?.id ?? null;
  if (d && typeof d === 'object') return (d as { id?: string }).id ?? null;
  return (r as { id?: string })?.id ?? null;
}

export interface SecretRow {
  id: string;
  type?: string;
  hostPattern?: string;
}

export interface OnecliAdmin {
  /** OneCLI internal agent id (uuid) for a given identifier, or null. */
  findAgentId(identifier: string): Promise<string | null>;
  /** Idempotently ensure an agent exists for the identifier; returns its uuid. */
  ensureAgent(name: string, identifier: string): Promise<string>;
  /**
   * Create an `anthropic`-type vault secret. Holds either an API key
   * (`sk-ant-api…`) or a subscription/OAuth token (`sk-ant-oat…`); OneCLI
   * auto-detects the auth mode from the value (x-api-key vs Authorization:
   * Bearer) and serves it as the api.anthropic.com provider credential.
   */
  createAnthropicSecret(name: string, value: string): Promise<string>;
  /**
   * Create the member's OpenAI/Codex vault secret. `oauth_token` stores the whole
   * ChatGPT/Codex `auth.json` via `--file` (host pattern `chatgpt.com`); `api_key`
   * stores the key via `--value` (host pattern `api.openai.com`). Mirrors how the
   * Codex provider's operator credential is registered (setup/providers/codex.ts).
   */
  createOpenAISecret(name: string, value: string, credType: UserCredsCredType): Promise<string>;
  /** Update a secret's value. `asFile=true` writes the value (e.g. a refreshed
   *  Codex auth.json) via `--file` instead of `--value`. */
  updateSecretValue(secretId: string, value: string, asFile?: boolean): Promise<void>;
  deleteSecret(secretId: string): Promise<void>;
  setSecretMode(agentId: string, mode: 'selective' | 'all'): Promise<void>;
  /** Secret IDs assigned to an agent. `agents secrets --id` returns bare id strings. */
  listAgentSecretIds(agentId: string): Promise<string[]>;
  /** All vault secrets (id + type) — used to classify an agent's assigned ids. */
  listAllSecrets(): Promise<SecretRow[]>;
  setSecrets(agentId: string, secretIds: string[]): Promise<void>;
}

export const realOnecliAdmin: OnecliAdmin = {
  async findAgentId(identifier) {
    const rows = dataArray(await onecli(['agents', 'list']));
    return (rows.find((a) => a.identifier === identifier)?.id as string | undefined) ?? null;
  },
  async ensureAgent(name, identifier) {
    const existing = await this.findAgentId(identifier);
    if (existing) return existing;
    await onecli(['agents', 'create', '--name', name, '--identifier', identifier]);
    const id = await this.findAgentId(identifier);
    if (!id) throw new Error(`onecli: agent ${identifier} not found after create`);
    return id;
  },
  async createAnthropicSecret(name, value) {
    const r = await onecli([
      'secrets',
      'create',
      '--name',
      name,
      '--type',
      'anthropic',
      '--value',
      value,
      '--host-pattern',
      'api.anthropic.com',
    ]);
    const id = createdId(r);
    if (!id) throw new Error('onecli: secrets create returned no id');
    return id;
  },
  async createOpenAISecret(name, value, credType) {
    // OAuth (ChatGPT/Codex subscription): the whole auth.json, stored via --file,
    // host chatgpt.com. API key: --value, host api.openai.com. The gateway serves
    // the value as the sentinel auth.json stub and swaps it on the wire.
    const r =
      credType === 'oauth_token'
        ? await withSecretFile(value, (path) =>
            onecli([
              'secrets',
              'create',
              '--name',
              name,
              '--type',
              'openai',
              '--file',
              path,
              '--host-pattern',
              'chatgpt.com',
            ]),
          )
        : await onecli([
            'secrets',
            'create',
            '--name',
            name,
            '--type',
            'openai',
            '--value',
            value,
            '--host-pattern',
            'api.openai.com',
          ]);
    const id = createdId(r);
    if (!id) throw new Error('onecli: secrets create returned no id');
    return id;
  },
  async updateSecretValue(secretId, value, asFile = false) {
    if (asFile) {
      await withSecretFile(value, (path) => onecli(['secrets', 'update', '--id', secretId, '--file', path]));
      return;
    }
    await onecli(['secrets', 'update', '--id', secretId, '--value', value]);
  },
  async deleteSecret(secretId) {
    await onecli(['secrets', 'delete', '--id', secretId]);
  },
  async setSecretMode(agentId, mode) {
    await onecli(['agents', 'set-secret-mode', '--id', agentId, '--mode', mode]);
  },
  async listAgentSecretIds(agentId) {
    const d = (await onecli(['agents', 'secrets', '--id', agentId])) as { data?: unknown };
    return Array.isArray(d.data) ? d.data.filter((x): x is string => typeof x === 'string') : [];
  },
  async listAllSecrets() {
    return dataArray(await onecli(['secrets', 'list'])).map((s) => ({
      id: s.id as string,
      type: s.type as string | undefined,
      hostPattern: s.hostPattern as string | undefined,
    }));
  },
  async setSecrets(agentId, secretIds) {
    await onecli(['agents', 'set-secrets', '--id', agentId, '--secret-ids', secretIds.join(',')]);
  },
};
