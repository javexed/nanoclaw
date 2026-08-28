// ── Thinking bubble (M3) ─────────────────────────────────────────────────────
// M2 stub: the status pipeline (runner status_events → agent-status module →
// adapter.sendStatus → WS `status` frames) lands in M3; until then the plain
// typing line covers "something is happening". This module owns the `status`
// event so ws.ts doesn't change shape when M3 arrives.
import { showAgentTyping, hideAgentTyping } from './transcript.js';
import { state } from '../core/state.js';

export function handleStatusEvent(msg: { room_id?: string; agent_name?: string | null; event?: string }): void {
  if (msg.room_id !== state.currentRoom) return;
  if (msg.event === 'start' || msg.event === 'tool' || msg.event === 'reasoning' || msg.event === 'progress') {
    showAgentTyping(msg.agent_name || 'Agent');
  } else if (msg.event === 'done' || msg.event === 'stalled') {
    hideAgentTyping();
  }
}
