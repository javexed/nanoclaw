// ── Management routes: agents, models, Ollama ───────────────────────────────
// The single-user build's whole management API in one file — the predecessor
// spread this over routes-agents.ts (1,511 lines), routes-models.ts (471) and
// routes-ollama.ts, most of which served features this build dropped
// (templates, skills, env/secrets, MCP attach, learning, routing). Single
// user means no privilege guards beyond csrf; authorization is authentication.
import { randomUUID } from 'crypto';

import { json, readJsonBody } from './http.js';
import type { RouteCtx } from '../server.js';
import { log } from '../../../log.js';
import { createAgentGroup, deleteAgentGroup, getAgentGroup, getAllAgentGroups } from '../../../db/agent-groups.js';
import { initGroupFilesystem } from '../../../group-init.js';
import type { AgentGroup } from '../../../types.js';
import {
  assignModelToAgent,
  updateWebchatModel,
  createWebchatModel,
  deleteWebchatModel,
  getAgentsAssignedToModel,
  getAssignedModelForAgent,
  getDefaultModelId,
  getWebchatModel,
  getWebchatRoomsForAgent,
  listWebchatModels,
  setDefaultModelId,
  unassignModelFromAgent,
  unwireAgentFromWebchatRoom,
  type WebchatModelKind,
} from '../db.js';
import {
  KNOWN_ANTHROPIC_MODELS,
  probeEndpointKind,
  validateModel,
  writeAgentSettingsForAssignedModel,
} from '../models.js';
import { probeContainerReachability } from '../reachability.js';
import { recommendForHost } from '../model-recommend.js';
import {
  cancelPull,
  deleteHostModel,
  getOllamaLocalState,
  getPullsSnapshot,
  listHostModels,
  startOllamaInstall,
  startPull,
} from '../ollama-manage.js';
import { draftAgent } from '../drafter.js';
import { readGroupPersona, writeGroupPersona } from '../../../group-persona.js';
import { resolveGroupFolderPath } from '../../../group-folder.js';
import { reloadAgentModelEnv, refreshUnassignedGroupsForDefaultModel } from './model-wiring.js';
import { wireAgentToRoom } from '../server.js';
import { broadcastRooms } from '../state.js';
import { clearPrimeAgentForAgentGroup } from '../db.js';

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

// ── Agents ──────────────────────────────────────────────────────────────────

function nameToFolder(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * agent_groups.id safe for OneCLI's `ensureAgent({ identifier })`, which
 * validates `[a-z][a-z0-9-]{0,49}`. A bare randomUUID fails when the first
 * hex char is a digit — silently: spawns retry forever and the user sees the
 * agent stuck "thinking". Prefix with `a` so the lead char is a letter.
 */
function newAgentGroupId(): string {
  return 'a' + randomUUID();
}

async function createAgent(
  name: string,
  instructions?: string,
): Promise<{ group: AgentGroup } | { error: string; status: number }> {
  const folder = nameToFolder(name);
  if (!folder) return { error: 'Could not derive folder from name', status: 400 };
  const group: AgentGroup = {
    id: newAgentGroupId(),
    name,
    folder,
    agent_provider: null,
    created_at: new Date().toISOString(),
  };
  try {
    await createAgentGroup(group);
  } catch (err) {
    return { error: `Could not create agent group: ${(err as Error).message}`, status: 409 };
  }
  await initGroupFilesystem(group, { instructions });
  // Materialize the model env NOW: a group born AFTER the default model was
  // set would otherwise have no settings.json until some later model change —
  // its first container would fall through to api.anthropic.com.
  try {
    await writeAgentSettingsForAssignedModel(group.id);
  } catch (err) {
    log.warn('Webchat: settings.json write for new agent group failed', { agentGroupId: group.id, err });
  }
  return { group };
}

export async function rAgentsDetailGet({ res }: RouteCtx): Promise<void> {
  const groups = await getAllAgentGroups();
  const defaultModelId = await getDefaultModelId();
  return json(res, 200, {
    default_model_id: defaultModelId,
    agents: await Promise.all(
      groups.map(async (g) => ({
        id: g.id,
        name: g.name,
        folder: g.folder,
        model_id: (await getAssignedModelForAgent(g.id))?.id ?? null,
        rooms: await getWebchatRoomsForAgent(g.id),
      })),
    ),
  });
}

export async function rAgentsPost(ctx: RouteCtx): Promise<void> {
  const body = await parseBody<{ name?: unknown; instructions?: unknown; room?: unknown }>(ctx);
  if (!body) return;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 60) return json(ctx.res, 400, { error: 'Agent name required (1-60 chars)' });
  const instructions = typeof body.instructions === 'string' ? body.instructions : undefined;
  const result = await createAgent(name, instructions);
  if ('error' in result) return json(ctx.res, result.status, { error: result.error });
  return json(ctx.res, 200, { agent: { id: result.group.id, name: result.group.name, folder: result.group.folder } });
}

/** LLM drafter: prompt → suggested name/instructions the create form prefills. */
export async function rAgentsDraftPost(ctx: RouteCtx): Promise<void> {
  const body = await parseBody<{ prompt?: unknown }>(ctx);
  if (!body) return;
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return json(ctx.res, 400, { error: 'prompt required' });
  try {
    return json(ctx.res, 200, { draft: await draftAgent(prompt) });
  } catch (err) {
    return json(ctx.res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function rAgentDelete(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const id = decodeURIComponent(m[1]);
  const group = await getAgentGroup(id);
  if (!group) return json(ctx.res, 404, { error: 'Agent not found' });
  // Unwire from every room first so no room is left routing at a ghost.
  for (const room of await getWebchatRoomsForAgent(id)) {
    await unwireAgentFromWebchatRoom(room.id, id);
  }
  await unassignModelFromAgent(id);
  await clearPrimeAgentForAgentGroup(id); // no ghost prime row pointing at the deleted agent
  await deleteAgentGroup(id);
  await broadcastRooms();
  return json(ctx.res, 200, { ok: true });
}

/** Assign (or clear, with model_id: null) an agent's model. */
export async function rAgentModelPut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const id = decodeURIComponent(m[1]);
  if (!(await getAgentGroup(id))) return json(ctx.res, 404, { error: 'Agent not found' });
  const body = await parseBody<{ model_id?: unknown }>(ctx);
  if (!body) return;
  if (body.model_id === null) {
    await unassignModelFromAgent(id);
  } else if (typeof body.model_id === 'string') {
    if (!(await getWebchatModel(body.model_id))) return json(ctx.res, 404, { error: 'Model not found' });
    await assignModelToAgent(id, body.model_id);
  } else {
    return json(ctx.res, 400, { error: 'model_id must be a string or null' });
  }
  await reloadAgentModelEnv(id, 'agent-model-change');
  return json(ctx.res, 200, { ok: true });
}

// ── Room ↔ agent wiring ─────────────────────────────────────────────────────

export async function rRoomAgentsPost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const roomId = decodeURIComponent(m[1]);
  const body = await parseBody<{ agent_group_id?: unknown }>(ctx);
  if (!body) return;
  const agentId = typeof body.agent_group_id === 'string' ? body.agent_group_id : '';
  if (!agentId || !(await getAgentGroup(agentId))) return json(ctx.res, 404, { error: 'Agent not found' });
  await wireAgentToRoom(roomId, agentId);
  return json(ctx.res, 200, { ok: true });
}

export async function rRoomAgentDelete(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const roomId = decodeURIComponent(m[1]);
  const agentId = decodeURIComponent(m[2]);
  const removed = await unwireAgentFromWebchatRoom(roomId, agentId);
  return json(ctx.res, removed ? 200 : 404, removed ? { ok: true } : { error: 'Not wired' });
}

// ── Models ──────────────────────────────────────────────────────────────────

export async function rModelsGet({ res }: RouteCtx): Promise<void> {
  return json(res, 200, {
    models: await listWebchatModels(),
    default_model_id: await getDefaultModelId(),
    known_anthropic: KNOWN_ANTHROPIC_MODELS,
  });
}

const MODEL_KINDS: WebchatModelKind[] = ['anthropic', 'ollama', 'openai-compatible'];

export async function rModelsPost(ctx: RouteCtx): Promise<void> {
  const body = await parseBody<{ name?: unknown; kind?: unknown; endpoint?: unknown; model_id?: unknown }>(ctx);
  if (!body) return;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const kind = typeof body.kind === 'string' ? (body.kind as WebchatModelKind) : ('' as WebchatModelKind);
  const endpoint = typeof body.endpoint === 'string' && body.endpoint.trim() ? body.endpoint.trim() : null;
  const modelId = typeof body.model_id === 'string' ? body.model_id.trim() : '';
  if (!name || name.length > 60) return json(ctx.res, 400, { error: 'name required (1-60 chars)' });
  if (!MODEL_KINDS.includes(kind))
    return json(ctx.res, 400, { error: `kind must be one of ${MODEL_KINDS.join(', ')}` });
  const problem = await validateModel({ kind, endpoint, model_id: modelId });
  if (problem) return json(ctx.res, 400, { error: problem });
  const model = {
    id: randomUUID(),
    name,
    kind,
    endpoint,
    model_id: modelId,
    credential_ref: null,
    created_at: Date.now(),
  };
  await createWebchatModel(model);
  return json(ctx.res, 200, { model });
}

export async function rModelIdPut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const id = decodeURIComponent(m[1]);
  const existing = await getWebchatModel(id);
  if (!existing) return json(ctx.res, 404, { error: 'Model not found' });
  const body = await parseBody<{ name?: unknown; endpoint?: unknown; model_id?: unknown }>(ctx);
  if (!body) return;
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : existing.name;
  const endpoint =
    body.endpoint === null
      ? null
      : typeof body.endpoint === 'string' && body.endpoint.trim()
        ? body.endpoint.trim()
        : existing.endpoint;
  const modelId = typeof body.model_id === 'string' && body.model_id.trim() ? body.model_id.trim() : existing.model_id;
  const problem = await validateModel({ kind: existing.kind, endpoint, model_id: modelId });
  if (problem) return json(ctx.res, 400, { error: problem });
  await updateWebchatModel(id, { name, endpoint, model_id: modelId });
  // Env may have changed for every agent on this model — re-materialize.
  for (const agentId of await getAgentsAssignedToModel(id)) {
    await reloadAgentModelEnv(agentId, 'model-edit');
  }
  return json(ctx.res, 200, { ok: true });
}

export async function rModelIdDelete(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const id = decodeURIComponent(m[1]);
  const existing = await getWebchatModel(id);
  if (!existing) return json(ctx.res, 404, { error: 'Model not found' });
  const assigned = await getAgentsAssignedToModel(id);
  const force = ctx.url.searchParams.get('force') === '1';
  if (assigned.length > 0 && !force) {
    const names = await Promise.all(assigned.map(async (a) => (await getAgentGroup(a))?.name ?? a));
    return json(ctx.res, 409, { error: 'Model is assigned', agents: names });
  }
  await deleteWebchatModel(id);
  if ((await getDefaultModelId()) === id) await setDefaultModelId(null);
  for (const agentId of assigned) await reloadAgentModelEnv(agentId, 'model-delete');
  return json(ctx.res, 200, { ok: true });
}

/** Install-wide default model (null clears). Re-points every unassigned group. */
export async function rModelsDefaultPut(ctx: RouteCtx): Promise<void> {
  const body = await parseBody<{ model_id?: unknown }>(ctx);
  if (!body) return;
  if (body.model_id !== null && typeof body.model_id !== 'string') {
    return json(ctx.res, 400, { error: 'model_id must be a string or null' });
  }
  if (typeof body.model_id === 'string' && !(await getWebchatModel(body.model_id))) {
    return json(ctx.res, 404, { error: 'Model not found' });
  }
  await setDefaultModelId(body.model_id as string | null);
  await refreshUnassignedGroupsForDefaultModel('default-model-change');
  return json(ctx.res, 200, { ok: true });
}

/** Two-pass custom-endpoint probe: detect the server kind, then its models. */
export async function rModelsProbeEndpointPost(ctx: RouteCtx): Promise<void> {
  const body = await parseBody<{ endpoint?: unknown }>(ctx);
  if (!body) return;
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
  if (!endpoint) return json(ctx.res, 400, { error: 'endpoint required' });
  try {
    return json(ctx.res, 200, await probeEndpointKind(endpoint));
  } catch (err) {
    return json(ctx.res, 502, { error: (err as Error).message });
  }
}

/** Container-vantage reachability: can the AGENT's container see this endpoint? */
export async function rModelsReachabilityPost(ctx: RouteCtx): Promise<void> {
  const body = await parseBody<{ endpoint?: unknown }>(ctx);
  if (!body) return;
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
  if (!endpoint) return json(ctx.res, 400, { error: 'endpoint required' });
  return json(ctx.res, 200, await probeContainerReachability(endpoint));
}

// ── Ollama console ──────────────────────────────────────────────────────────

export async function rOllamaHostsGet({ res }: RouteCtx): Promise<void> {
  const hosts = new Set<string>();
  for (const m of await listWebchatModels()) {
    if (m.kind === 'ollama' && m.endpoint) hosts.add(m.endpoint.replace(/\/+$/, ''));
  }
  const envHost = (process.env.OLLAMA_HOST || '').trim();
  if (envHost) hosts.add(envHost.replace(/\/+$/, ''));
  if (hosts.size === 0) hosts.add('http://127.0.0.1:11434');
  return json(res, 200, { hosts: [...hosts].sort() });
}

export async function rOllamaModelsGet({ res, url }: RouteCtx): Promise<void> {
  const host = url.searchParams.get('host') || '';
  if (!host) return json(res, 400, { error: 'host required' });
  try {
    return json(res, 200, { models: await listHostModels(host) });
  } catch (err) {
    return json(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function rOllamaPullsGet({ res }: RouteCtx): Promise<void> {
  return json(res, 200, { pulls: getPullsSnapshot() });
}

export async function rOllamaPullPost(ctx: RouteCtx): Promise<void> {
  const body = await parseBody<{ host?: unknown; model?: unknown }>(ctx);
  if (!body) return;
  if (typeof body.host !== 'string' || !body.host.trim()) return json(ctx.res, 400, { error: 'host required' });
  if (typeof body.model !== 'string' || !body.model.trim()) return json(ctx.res, 400, { error: 'model required' });
  try {
    return json(ctx.res, 202, { pull: await startPull(body.host.trim(), body.model.trim()) });
  } catch (err) {
    return json(ctx.res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function rOllamaPullCancelPost(ctx: RouteCtx): Promise<void> {
  const body = await parseBody<{ host?: unknown; model?: unknown }>(ctx);
  if (!body) return;
  if (typeof body.host !== 'string' || !body.host.trim()) return json(ctx.res, 400, { error: 'host required' });
  if (typeof body.model !== 'string' || !body.model.trim()) return json(ctx.res, 400, { error: 'model required' });
  // 404, not 200: "there was no such pull" is a different fact from "it is
  // stopped now" — a UI that can't tell them apart claims to have cancelled a
  // pull that actually completed a moment earlier.
  if (!cancelPull(body.host.trim(), body.model.trim())) return json(ctx.res, 404, { error: 'no pull in progress' });
  return json(ctx.res, 200, { ok: true });
}

export async function rOllamaDeletePost(ctx: RouteCtx): Promise<void> {
  const body = await parseBody<{ host?: unknown; model?: unknown }>(ctx);
  if (!body) return;
  if (typeof body.host !== 'string' || !body.host.trim()) return json(ctx.res, 400, { error: 'host required' });
  if (typeof body.model !== 'string' || !body.model.trim()) return json(ctx.res, 400, { error: 'model required' });
  try {
    await deleteHostModel(body.host.trim(), body.model.trim());
    return json(ctx.res, 200, { ok: true });
  } catch (err) {
    return json(ctx.res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Hardware profile + a recommended local model (plus remote-Ollama hint). */
export async function rOllamaRecommendGet({ res }: RouteCtx): Promise<void> {
  const remote = (await listWebchatModels()).find((m) => {
    if (m.kind !== 'ollama' || !m.endpoint) return false;
    let host = '';
    try {
      host = new URL(m.endpoint).hostname;
    } catch {
      /* skip */
    }
    return Boolean(host) && !['127.0.0.1', 'localhost', '::1', 'host.docker.internal'].includes(host);
  });
  return json(res, 200, {
    ...recommendForHost(),
    remoteOllama: remote ? { present: true, endpoint: remote.endpoint } : { present: false },
  });
}

export async function rOllamaLocalGet({ res }: RouteCtx): Promise<void> {
  return json(res, 200, await getOllamaLocalState());
}

export async function rOllamaInstallPost({ res }: RouteCtx): Promise<void> {
  const result = startOllamaInstall();
  return json(res, result.started ? 202 : 409, result);
}

// Re-exported for the WebchatModelKind consumers in the route table typing.
export type { WebchatModelKind };

// ── Standing instructions (instructions.prepend.md) ─────────────────────────
// The composed CLAUDE.md is spawn-generated; this file is the operator-owned
// part that gets prepended into it. Edits apply at the next container spawn.

const INSTRUCTIONS_MAX_BYTES = 256 * 1024;

export async function rAgentInstructionsGet(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const id = decodeURIComponent(m[1]);
  const group = await getAgentGroup(id);
  if (!group) return json(ctx.res, 404, { error: 'Agent not found' });
  const dir = resolveGroupFolderPath(group.folder);
  return json(ctx.res, 200, { instructions: readGroupPersona(dir) ?? '' });
}

export async function rAgentInstructionsPut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const id = decodeURIComponent(m[1]);
  const group = await getAgentGroup(id);
  if (!group) return json(ctx.res, 404, { error: 'Agent not found' });
  const body = await parseBody<{ instructions?: unknown }>(ctx);
  if (!body) return;
  if (typeof body.instructions !== 'string') return json(ctx.res, 400, { error: 'instructions must be a string' });
  if (Buffer.byteLength(body.instructions) > INSTRUCTIONS_MAX_BYTES) {
    return json(ctx.res, 413, { error: 'Instructions too large (256KB max)' });
  }
  writeGroupPersona(resolveGroupFolderPath(group.folder), body.instructions);
  return json(ctx.res, 200, { ok: true, applies: 'next-session' });
}
