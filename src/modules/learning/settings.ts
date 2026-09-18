/**
 * Per-agent learning settings — the auto-trigger switch and its cooldown.
 * Stored in the learning module's own table so container_configs stays
 * untouched; materialized into container.json by container-config.ts.
 */
import { getDb } from '../../db/connection.js';

export interface AgentLearningSettings {
  /** Busy turns auto-run the review. Default on — it only ever stages a draft. */
  autoTrigger: boolean;
  /** Minimum minutes between auto reviews per container. Default 30. */
  cooldownMinutes: number;
}

const DEFAULTS: AgentLearningSettings = { autoTrigger: true, cooldownMinutes: 30 };

export async function getAgentLearning(agentGroupId: string): Promise<AgentLearningSettings> {
  try {
    const row = (await getDb().get(
      'SELECT auto_trigger, cooldown_minutes FROM learning_agent_settings WHERE agent_group_id = ?',
      agentGroupId,
    )) as { auto_trigger: number; cooldown_minutes: number } | undefined;
    if (!row) return { ...DEFAULTS };
    return { autoTrigger: row.auto_trigger === 1, cooldownMinutes: row.cooldown_minutes };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function setAgentLearning(
  agentGroupId: string,
  patch: Partial<AgentLearningSettings>,
): Promise<AgentLearningSettings> {
  const next = { ...(await getAgentLearning(agentGroupId)), ...patch };
  next.cooldownMinutes = Math.max(1, Math.min(24 * 60, Math.round(next.cooldownMinutes)));
  await getDb().run(
    `INSERT INTO learning_agent_settings (agent_group_id, auto_trigger, cooldown_minutes)
       VALUES (?, ?, ?)
       ON CONFLICT(agent_group_id) DO UPDATE SET auto_trigger = excluded.auto_trigger, cooldown_minutes = excluded.cooldown_minutes`,
    agentGroupId,
    next.autoTrigger ? 1 : 0,
    next.cooldownMinutes,
  );
  return next;
}

/** The `learning` blob for container.json — what the runner reads. */
export async function learningConfigFor(
  agentGroupId: string,
): Promise<{ autoTrigger: boolean; cooldownMinutes: number }> {
  const s = await getAgentLearning(agentGroupId);
  return { autoTrigger: s.autoTrigger, cooldownMinutes: s.cooldownMinutes };
}
