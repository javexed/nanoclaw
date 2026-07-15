/**
 * Per-room learning settings (auto-distill / auto-keep) — the room layer of
 * the learning config. Precedence, most specific first:
 *
 *   room (learning_room_settings, keyed by messaging group)
 *     → agent (container_configs.learning)
 *       → defaults (autoTrigger ON, autoKeep OFF)
 *
 * The room layer reaches containers as a `rooms` map inside the group's
 * materialized learning config, keyed "<channel_type>:<platform_id>" — the
 * pair the agent-runner already knows from its routing context. No new IO
 * surface: it rides container.json like every other per-group setting.
 */
import { getDb } from '../../db/connection.js';

export interface RoomLearning {
  autoTrigger?: boolean;
  autoKeep?: boolean;
}

export function getRoomLearning(messagingGroupId: string): RoomLearning {
  try {
    const row = getDb()
      .prepare(`SELECT settings FROM learning_room_settings WHERE messaging_group_id = ?`)
      .get(messagingGroupId) as { settings: string } | undefined;
    return row ? (JSON.parse(row.settings) as RoomLearning) : {};
  } catch {
    return {};
  }
}

export function setRoomLearning(messagingGroupId: string, patch: RoomLearning): RoomLearning {
  const next = { ...getRoomLearning(messagingGroupId), ...patch };
  getDb()
    .prepare(
      `INSERT INTO learning_room_settings (messaging_group_id, settings, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(messaging_group_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`,
    )
    .run(messagingGroupId, JSON.stringify(next), Date.now());
  return next;
}

/**
 * The `rooms` map for one agent group's materialized learning config: every
 * messaging group wired to it that HAS a room-level setting, keyed by
 * "<channel_type>:<platform_id>". Empty object when no room overrides exist.
 */
export function roomLearningMapForAgent(agentGroupId: string): Record<string, RoomLearning> {
  const out: Record<string, RoomLearning> = {};
  try {
    const rows = getDb()
      .prepare(
        `SELECT mg.channel_type AS ct, mg.platform_id AS pid, lrs.settings AS settings
         FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
         JOIN learning_room_settings lrs ON lrs.messaging_group_id = mg.id
         WHERE mga.agent_group_id = ?`,
      )
      .all(agentGroupId) as { ct: string; pid: string; settings: string }[];
    for (const r of rows) {
      try {
        const s = JSON.parse(r.settings) as RoomLearning;
        if (s.autoTrigger !== undefined || s.autoKeep !== undefined) out[`${r.ct}:${r.pid}`] = s;
      } catch {
        continue;
      }
    }
  } catch {
    /* table missing (pre-migration) — no overrides */
  }
  return out;
}
