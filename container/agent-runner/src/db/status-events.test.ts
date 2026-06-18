import { beforeEach, describe, expect, test } from 'bun:test';

import { appendStatusEvent, clearStatusEvents, getOutboundDb, initTestSessionDb } from './connection.js';

beforeEach(() => {
  initTestSessionDb();
});

interface StatusRow {
  seq: number;
  kind: string;
  text: string | null;
  detail: string | null;
}

function rows(): StatusRow[] {
  return getOutboundDb().prepare('SELECT seq, kind, text, detail FROM status_events ORDER BY seq ASC').all() as StatusRow[];
}

describe('status_events feed (webchat thinking bubble)', () => {
  test('append stores kind/text/detail in order', () => {
    appendStatusEvent('tool', 'Read', 'src/foo.ts');
    appendStatusEvent('progress', 'Build the app');
    appendStatusEvent('done', null);

    const r = rows();
    expect(r.map((x) => x.kind)).toEqual(['tool', 'progress', 'done']);
    expect(r[0]).toMatchObject({ kind: 'tool', text: 'Read', detail: 'src/foo.ts' });
    expect(r[1]).toMatchObject({ kind: 'progress', text: 'Build the app', detail: null });
    expect(r[2]).toMatchObject({ kind: 'done', text: null, detail: null });
    // seq is strictly increasing.
    expect(r[1].seq).toBeGreaterThan(r[0].seq);
    expect(r[2].seq).toBeGreaterThan(r[1].seq);
  });

  test('clear wipes rows but seq keeps climbing (host watermark stays valid)', () => {
    appendStatusEvent('tool', 'Bash', 'pnpm build');
    appendStatusEvent('tool', 'Read', 'a.ts');
    const seqBeforeClear = rows().at(-1)!.seq;
    expect(rows()).toHaveLength(2);

    clearStatusEvents();
    expect(rows()).toHaveLength(0);

    // A new turn's first event must have a HIGHER seq than anything before the
    // clear — otherwise the host's `seq > watermark` query would skip it.
    appendStatusEvent('progress', 'New turn');
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0].seq).toBeGreaterThan(seqBeforeClear);
  });

  test('append never throws even with odd input', () => {
    expect(() => appendStatusEvent('reasoning', null, null)).not.toThrow();
    expect(() => appendStatusEvent('tool', '', '')).not.toThrow();
  });
});
