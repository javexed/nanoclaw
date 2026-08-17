/**
 * New-session backfill (the pull half of cross-session context): a just-born
 * DM session is seeded with the DM's TOP-LEVEL timeline from sibling sessions
 * — each sibling's root user message + top-level agent posts (welcome-style),
 * never the interiors of other threads. Live-hit this guards against: the
 * user replies to the welcome tour offer, the reply roots a new thread, and
 * the fresh session knows nothing about the offer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const written: Array<Record<string, unknown>> = [];
const inboundSql: string[] = [];
const outboundSql: string[] = [];

let inboundRows: Array<{ timestamp: string; content: string }> = [];
let outboundRows: Array<{ timestamp: string; content: string }> = [];
let siblingSessions: Array<{ id: string; status: string; messaging_group_id: string | null }> = [];

vi.mock('fs', () => ({ default: { existsSync: () => true }, existsSync: () => true }));
vi.mock('../../session-manager.js', () => ({
  inboundDbPath: (g: string, s: string) => `/tmp/${g}/${s}/inbound.db`,
  withInboundDb: (_g: string, _s: string, fn: (db: unknown) => unknown) =>
    fn({
      prepare: (sql: string) => {
        inboundSql.push(sql);
        return { all: () => inboundRows };
      },
    }),
  openOutboundDb: () => ({
    prepare: (sql: string) => {
      outboundSql.push(sql);
      return { all: () => outboundRows };
    },
    close: () => {},
  }),
  writeSessionMessage: (agentGroupId: string, sessionId: string, msg: Record<string, unknown>) => {
    written.push({ agentGroupId, sessionId, ...msg });
  },
}));
vi.mock('../../db/sessions.js', () => ({
  getSessionsByAgentGroup: () => siblingSessions,
  isTaskThread: (t: string) => t.startsWith('system:tasks'),
}));

const { backfillNewDmSession, BACKFILL_LIMIT } = await import('./backfill.js');

const AG = { id: 'ag-1', name: 'Pete', folder: 'pete', agent_provider: null, created_at: '' } as never;
const DM_MG = { id: 'mg-dm', channel_type: 'slack', platform_id: 'slack:D1', is_group: 0 } as never;
const ROOM_MG = { id: 'mg-room', channel_type: 'slack', platform_id: 'slack:C1', is_group: 1 } as never;
const NEW_SESSION = {
  id: 'sess-new',
  agent_group_id: 'ag-1',
  messaging_group_id: 'mg-dm',
  thread_id: 'slack:D1:2.0',
} as never;

function chat(text: string, sender = 'Gavriel', senderId = 'U1'): string {
  return JSON.stringify({ text, sender, senderId });
}

beforeEach(() => {
  written.length = 0;
  inboundSql.length = 0;
  outboundSql.length = 0;
  inboundRows = [];
  outboundRows = [];
  siblingSessions = [{ id: 'sess-old', status: 'active', messaging_group_id: 'mg-dm' }];
});

describe('backfillNewDmSession', () => {
  it('seeds the new session with sibling roots + top-level agent posts, ordered by time', () => {
    outboundRows = [
      { timestamp: '2026-08-01T19:14:00Z', content: JSON.stringify({ text: 'Hey Gavriel! I am Pete… tour?' }) },
    ];
    inboundRows = [{ timestamp: '2026-08-01T19:10:00Z', content: chat('hello there') }];

    backfillNewDmSession(AG, NEW_SESSION, DM_MG);

    expect(written).toHaveLength(2);
    expect(written[0]).toMatchObject({
      sessionId: 'sess-new',
      kind: 'chat',
      channelType: 'session-echo',
      trigger: 0,
    });
    const first = JSON.parse(written[0]!.content as string) as Record<string, unknown>;
    const second = JSON.parse(written[1]!.content as string) as Record<string, unknown>;
    expect(first.text).toBe('hello there');
    expect(second.text).toBe('Hey Gavriel! I am Pete… tour?');
    expect(second.sender).toBe('Pete');
    expect((second.echo as Record<string, unknown>).surface).toBe('dm-timeline');
    expect(second.self).toBe(true);
    expect(first.self).toBeUndefined();
  });

  it('queries only conversation roots inbound and top-level outbound (SQL shape)', () => {
    backfillNewDmSession(AG, NEW_SESSION, DM_MG);
    expect(inboundSql[0]).toContain('ORDER BY seq ASC LIMIT 1');
    expect(inboundSql[0]).toContain('trigger = 1');
    expect(outboundSql[0]).toContain("thread_id IS NULL OR thread_id = '' OR thread_id LIKE '%:'");
    expect(outboundSql[0]).toContain("kind NOT IN ('system','task_log')");
  });

  it('skips rooms, task sessions, and sessions without siblings', () => {
    backfillNewDmSession(AG, NEW_SESSION, ROOM_MG);
    backfillNewDmSession(AG, { ...(NEW_SESSION as object), thread_id: 'system:tasks:t-1' } as never, DM_MG);
    siblingSessions = [];
    backfillNewDmSession(AG, NEW_SESSION, DM_MG);
    expect(written).toHaveLength(0);
  });

  it('ignores system-sender roots and caps at BACKFILL_LIMIT newest rows', () => {
    inboundRows = [{ timestamp: '2026-08-01T18:00:00Z', content: chat('Introduce yourself', 'system', 'system') }];
    outboundRows = Array.from({ length: 20 }, (_, i) => ({
      timestamp: `2026-08-01T19:${String(10 + i).padStart(2, '0')}:00Z`,
      content: JSON.stringify({ text: `post ${i}` }),
    }));

    backfillNewDmSession(AG, NEW_SESSION, DM_MG);

    expect(written).toHaveLength(BACKFILL_LIMIT);
    const texts = written.map((w) => (JSON.parse(w.content as string) as { text: string }).text);
    expect(texts).not.toContain('Introduce yourself');
    expect(texts.at(-1)).toBe('post 19');
  });

  it('only considers siblings of the same messaging group', () => {
    siblingSessions = [{ id: 'sess-other-dm', status: 'active', messaging_group_id: 'mg-other' }];
    backfillNewDmSession(AG, NEW_SESSION, DM_MG);
    expect(written).toHaveLength(0);
  });
});
