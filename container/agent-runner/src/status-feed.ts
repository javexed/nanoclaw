/**
 * Webchat status feed — consumer of the provider message seam.
 *
 * Registers a provider-message observer that turns turn activity into
 * `status_events` rows (the thinking-bubble's live feed). Provider code knows
 * nothing about the feed; it notifies observers, and this observer writes the
 * rows. Loaded for side effects from the runner entry (index.ts).
 *
 * Best-effort by contract: a write failure must never break the tool call it
 * observes (the seam's notify wrapper also guarantees that).
 */
import { getOutboundDb } from './mailbox/sqlite/connection.js';
import { registerProviderMessageObserver } from './providers/hooks.js';

/**
 * Pull a short, human-meaningful target out of a tool's input for the feed —
 * the file a Read/Edit touches, the command Bash runs, the query a search
 * uses. Returns null when the tool has no salient target (the client then
 * shows just the tool verb). Host-side redaction scrubs secrets before any
 * of this reaches a client.
 */
export function summarizeToolTarget(toolName: string, input: Record<string, unknown> | undefined): string | null {
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  switch (toolName) {
    case 'Bash':
      return str(input?.command);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return str(input?.file_path) ?? str(input?.notebook_path);
    case 'Glob':
    case 'Grep':
      return str(input?.pattern);
    case 'WebFetch':
      return str(input?.url);
    case 'WebSearch':
      return str(input?.query);
    // OpenCode/local-harness built-ins: lowercase names and their own
    // argument keys, so they miss every case above and would otherwise render
    // as a bare verb.
    case 'read':
    case 'write':
    case 'edit':
      return str(input?.path) ?? str(input?.file_path);
    case 'bash':
      return str(input?.command) ?? str(input?.cmd);
    default:
      return null;
  }
}

registerProviderMessageObserver((ev) => {
  switch (ev.kind) {
    case 'tool_use':
      appendStatusEvent('tool', ev.toolName, summarizeToolTarget(ev.toolName, ev.toolInput));
      break;
    case 'batch_start':
      // Fresh batch accepted: reset the feed so the bubble shows only this
      // turn's events.
      clearStatusEvents();
      break;
    case 'turn_start':
      // A follow-up sub-turn inside a long-lived query cycles the feed: clear
      // the previous sub-turn's snapshot so the bubble doesn't freeze on it.
      if (ev.resetFeed) clearStatusEvents();
      appendStatusEvent('start', null);
      break;
    case 'turn_done':
      appendStatusEvent('done', null);
      break;
    case 'progress':
      appendStatusEvent('progress', ev.text);
      break;
    case 'reasoning':
      appendStatusEvent('reasoning', ev.text);
      break;
  }
});

/**
 * Max status_events rows to keep mid-turn. The host only needs rows past its
 * watermark and clearStatusEvents() wipes the table each turn, so this is a
 * safety cap against a pathological turn emitting thousands of events.
 */
const STATUS_EVENTS_CAP = 200;

/**
 * Append one activity event. Best-effort and purely cosmetic — it must never
 * throw into the caller (a missing table on an older outbound.db, a locked
 * write, etc. are all swallowed).
 */
export function appendStatusEvent(kind: string, text: string | null, detail: string | null = null): void {
  try {
    const db = getOutboundDb();
    db.prepare(`INSERT INTO status_events (kind, text, detail, created_at) VALUES ($kind, $text, $detail, $now)`).run({
      $kind: kind,
      $text: text,
      $detail: detail,
      $now: new Date().toISOString(),
    });
    // Trim everything older than the most recent CAP rows.
    db.prepare(`DELETE FROM status_events WHERE seq <= (SELECT MAX(seq) FROM status_events) - $cap`).run({
      $cap: STATUS_EVENTS_CAP,
    });
  } catch {
    // Cosmetic feed — never let it disrupt the turn.
  }
}

/**
 * Wipe the feed at the start of a turn so it reflects only the current turn's
 * activity. Safe across turns: AUTOINCREMENT means the next row's seq is
 * still higher than the host's watermark, so nothing is missed or replayed.
 */
export function clearStatusEvents(): void {
  try {
    getOutboundDb().prepare(`DELETE FROM status_events`).run();
  } catch {
    // ignore — see appendStatusEvent
  }
}
