import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { restartAgentGroupContainers } from '../../container-restart.js';
import { getDb } from '../../db/connection.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';
import { writeDestinations } from '../../modules/agent-to-agent/write-destinations.js';
import { registerResource } from '../crud.js';

/**
 * After a destinations change for `agentGroupId`, force any active session to
 * see the new destination map immediately. Three things have to happen — only
 * doing the first is the silent-bug path:
 *
 *   1. Project the central agent_destinations rows into each active session's
 *      inbound.db (`writeDestinations`). This is what `findByName` /
 *      `findByRouting` read in the agent-runner's formatter.
 *   2. Archive the claude-code SDK's per-PID session record + jsonl
 *      transcripts under `.claude-shared/`. Without this, the SDK rediscovers
 *      the prior session on next spawn — same session ID, same Anthropic
 *      prompt-cache key, same stale destination list in the LLM's view. The
 *      LLM keeps replying to whatever destination was current when the cached
 *      pre-prompt was built. Keep-in-sync with container CWD: the projects
 *      subdir name is derived from `/workspace/agent` (see `CWD` in
 *      container/agent-runner/src/index.ts).
 *   3. Kill any running container so the next message spawns a fresh one
 *      (which calls `writeDestinations` again on spawn and creates a new
 *      claude-code session id). The in-flight LLM turn — if any — loses its
 *      transcript update; that's acceptable, we're invalidating its world
 *      anyway.
 *
 * Idempotent — safe to call when there are no active sessions or no SDK
 * state files yet.
 */
/**
 * Upstream-shaped export (wirings.ts postCreate): live-project the central
 * agent_destinations rows into every session's inbound.db WITHOUT the full
 * session invalidation refreshAgentSessions does. New wirings have no stale
 * prompt-cache problem, so projection alone is enough there.
 */
export async function projectDestinationsToSessions(agentGroupId: string): Promise<void> {
  const { writeDestinations } = await import('../../modules/agent-to-agent/write-destinations.js');
  for (const session of getSessionsByAgentGroup(agentGroupId)) {
    try {
      writeDestinations(agentGroupId, session.id);
    } catch (err) {
      log.warn('writeDestinations failed; agent will pick up changes on next spawn', {
        agentGroupId,
        sessionId: session.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function refreshAgentSessions(agentGroupId: string, reason: string): void {
  const sessions = getSessionsByAgentGroup(agentGroupId).filter((s) => s.status === 'active');
  for (const s of sessions) {
    try {
      writeDestinations(agentGroupId, s.id);
    } catch (err) {
      log.warn('writeDestinations failed; agent will pick up changes on next spawn', {
        agentGroupId,
        sessionId: s.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const sharedDir = path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.claude-shared');
  if (fs.existsSync(sharedDir)) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const archiveDir = path.join(sharedDir, `.archive-${stamp}`);
    let archivedAny = false;

    const sessionsDir = path.join(sharedDir, 'sessions');
    if (fs.existsSync(sessionsDir)) {
      for (const f of fs.readdirSync(sessionsDir)) {
        if (!f.endsWith('.json')) continue;
        if (!archivedAny) fs.mkdirSync(archiveDir, { recursive: true });
        fs.renameSync(path.join(sessionsDir, f), path.join(archiveDir, f));
        archivedAny = true;
      }
    }

    const projectsDir = path.join(sharedDir, 'projects', '-workspace-agent');
    if (fs.existsSync(projectsDir)) {
      for (const f of fs.readdirSync(projectsDir)) {
        // Keep `memory/` and any other directories the agent uses for durable
        // notes; only move the SDK's own jsonl transcripts + session dirs
        // (which are named after a session UUID).
        const full = path.join(projectsDir, f);
        const isJsonl = f.endsWith('.jsonl');
        const isUuidDir = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(f);
        if (!isJsonl && !isUuidDir) continue;
        if (!archivedAny) fs.mkdirSync(archiveDir, { recursive: true });
        fs.renameSync(full, path.join(archiveDir, f));
        archivedAny = true;
      }
    }

    if (archivedAny) {
      log.info('Archived claude-code SDK state for fresh session', { agentGroupId, archiveDir, reason });
    }
  }

  restartAgentGroupContainers(agentGroupId, reason);
}

registerResource({
  name: 'destination',
  plural: 'destinations',
  table: 'agent_destinations',
  description:
    'Agent destination — per-agent routing entry and ACL. Each row authorizes an agent to send messages to a target (channel or another agent) and assigns a local name the agent uses to address it. Names are scoped to the source agent — two agents can have different local names for the same target. Created automatically when wiring channels or when agents create child agents.',
  idColumn: 'agent_group_id',
  scopeField: 'agent_group_id',
  columns: [
    {
      name: 'agent_group_id',
      type: 'string',
      description: 'The agent that owns this destination. References agent_groups.id.',
    },
    {
      name: 'local_name',
      type: 'string',
      description:
        'Name the agent uses to address this target (e.g. send_message({ to: "local_name", ... })). Unique per agent. Lowercase, dash-separated.',
    },
    {
      name: 'target_type',
      type: 'string',
      description: '"channel" for messaging group targets, "agent" for agent-to-agent targets.',
      enum: ['channel', 'agent'],
    },
    {
      name: 'target_id',
      type: 'string',
      description: "The target's ID — messaging_groups.id for channels, agent_groups.id for agents.",
    },
    { name: 'channel_type', type: 'string', description: 'Resolved channel type for channel destinations.' },
    { name: 'display_name', type: 'string', description: 'Resolved chat title or agent name.' },
    { name: 'created_at', type: 'string', description: 'Auto-set.' },
  ],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: 'List destinations with resolved channel/title labels.',
      handler: async (args) => {
        const agentGroupId = (args.agent_group_id as string | undefined) ?? (args.id as string | undefined);
        const params: unknown[] = [];
        const where = agentGroupId ? 'WHERE ad.agent_group_id = ?' : '';
        if (agentGroupId) params.push(agentGroupId);
        return getDb()
          .prepare(
            `SELECT
               ad.agent_group_id,
               ad.local_name,
               ad.target_type,
               ad.target_id,
               CASE WHEN ad.target_type = 'channel' THEN mg.channel_type ELSE NULL END AS channel_type,
               CASE WHEN ad.target_type = 'channel' THEN mg.name ELSE ag.name END AS display_name,
               ad.created_at
             FROM agent_destinations ad
             LEFT JOIN messaging_groups mg ON ad.target_type = 'channel' AND ad.target_id = mg.id
             LEFT JOIN agent_groups ag ON ad.target_type = 'agent' AND ad.target_id = ag.id
             ${where}
             ORDER BY ad.agent_group_id, ad.local_name`,
          )
          .all(...params);
      },
    },
    add: {
      access: 'approval',
      description: 'Add a destination for an agent. Use --agent-group-id, --local-name, --target-type, --target-id.',
      handler: async (args) => {
        const agentGroupId = args.agent_group_id as string;
        const localName = args.local_name as string;
        const targetType = args.target_type as string;
        const targetId = args.target_id as string;
        if (!agentGroupId) throw new Error('--agent-group-id is required');
        if (!localName) throw new Error('--local-name is required');
        if (!targetType || !['channel', 'agent'].includes(targetType)) {
          throw new Error('--target-type must be channel or agent');
        }
        if (!targetId) throw new Error('--target-id is required');
        getDb()
          .prepare(
            `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(agentGroupId, localName, targetType, targetId, new Date().toISOString());
        refreshAgentSessions(agentGroupId, `destination added: ${localName}`);
        return { agent_group_id: agentGroupId, local_name: localName, target_type: targetType, target_id: targetId };
      },
    },
    remove: {
      access: 'approval',
      description: 'Remove a destination from an agent. Use --agent-group-id and --local-name.',
      handler: async (args) => {
        const agentGroupId = args.agent_group_id as string;
        const localName = args.local_name as string;
        if (!agentGroupId) throw new Error('--agent-group-id is required');
        if (!localName) throw new Error('--local-name is required');
        const result = getDb()
          .prepare('DELETE FROM agent_destinations WHERE agent_group_id = ? AND local_name = ?')
          .run(agentGroupId, localName);
        if (result.changes === 0) throw new Error('destination not found');
        refreshAgentSessions(agentGroupId, `destination removed: ${localName}`);
        return { removed: { agent_group_id: agentGroupId, local_name: localName } };
      },
    },
  },
});
