// ── Model assignment propagation ─────────────────────────────────────────────
// What has to happen elsewhere when a model binding changes: push the new model
// into a group's container environment, and re-point the groups still running on
// the workspace default.
//
// Shared rather than moved. The model routes change bindings, but so does the
// agent-model assignment route, the workspace-model route and the hook that runs
// after a workspace credential is set — none of them in the model cluster.

/**
 * Re-materialize an agent group's model env into settings.json and force any
 * running container to respawn so the change actually takes effect.
 *
 * The model env (ANTHROPIC_MODEL / ANTHROPIC_BASE_URL) is read only at container
 * spawn, so without the restart a live container keeps serving the previous
 * model until it idles out — which the operator reads as "the switch didn't
 * take" (and surfaces as a wrong-model error). No wake message is written: we
 * don't want a spurious agent turn, just a clean env on the next real message.
 * restartAgentGroupContainers only respawns eagerly when there's already
 * pending work; otherwise it kills and waits for the next inbound. Each step is
 * isolated so a failure in one agent group doesn't abort the rest of the batch.
 */
import { restartAgentGroupContainers } from '../../../container-restart.js';
import { getAllAgentGroups } from '../../../db/agent-groups.js';
import { getContainerConfig } from '../../../db/container-configs.js';
import { log } from '../../../log.js';
import { getAssignedModelForAgent } from '../db.js';
import { syncAgentProviderForAssignedModel, writeAgentSettingsForAssignedModel } from '../models.js';

export async function reloadAgentModelEnv(agentGroupId: string, reason: string): Promise<void> {
  try {
    await writeAgentSettingsForAssignedModel(agentGroupId);
  } catch (err) {
    log.warn('Webchat: settings.json write after model change failed', { agentGroupId, reason, err });
  }
  try {
    // Provider follows the assigned model's kind. Every kind now runs on the
    // default harness, so this always syncs back to the default provider (it
    // still runs to un-wedge any group a legacy install left on a non-default
    // provider). Same next-spawn timing as the env write; the restart applies both.
    await syncAgentProviderForAssignedModel(agentGroupId);
  } catch (err) {
    log.warn('Webchat: provider sync after model change failed', { agentGroupId, reason, err });
  }
  try {
    const restarted = await restartAgentGroupContainers(agentGroupId, reason);
    if (restarted > 0) {
      log.info('Webchat: restarted containers after model change', { agentGroupId, reason, restarted });
    }
  } catch (err) {
    log.warn('Webchat: container restart after model change failed', { agentGroupId, reason, err });
  }
}

/**
 * Re-materialize settings.json + respawn for every claude-family group WITHOUT
 * its own model assignment — the population the workspace default model serves.
 * Assigned groups are untouched (their assignment wins), as are non-Claude
 * (Codex) groups (their harness ignores the ANTHROPIC_* env this writes).
 */
export async function refreshUnassignedGroupsForDefaultModel(reason: string): Promise<void> {
  for (const g of await getAllAgentGroups()) {
    if (await getAssignedModelForAgent(g.id)) continue;
    const provider = (await getContainerConfig(g.id))?.provider;
    // Codex ignores the ANTHROPIC_* env and has no local-model wiring — skip it.
    // OpenCode DOES follow the default local model, so it's processed: the sync
    // below re-derives its provider and rewrites its per-agent local-model.json
    // to the new default (and flips an unassigned Claude group to OpenCode when the
    // default is a local model + OpenCode is installed).
    if (provider && provider !== 'claude' && provider !== 'opencode') continue;
    try {
      await writeAgentSettingsForAssignedModel(g.id);
      await syncAgentProviderForAssignedModel(g.id);
    } catch (err) {
      log.warn('Webchat: settings.json write for default-model change failed', { agentGroupId: g.id, reason, err });
    }
    try {
      await restartAgentGroupContainers(g.id, reason);
    } catch (err) {
      log.warn('Webchat: container restart for default-model change failed', { agentGroupId: g.id, reason, err });
    }
  }
}
