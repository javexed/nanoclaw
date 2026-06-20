// Webchat thinking-bubble activity mapping for the codex provider.
// Shipped by the webchat overlay (install-webchat) only when codex is installed;
// not part of upstream's codex payload, so it is never clobbered by /add-codex.
// Tests the pure `codexItemStatus` mapper — shapes confirmed against codex 0.138.0
// `protocol/v2/item.rs` and a live authed app-server capture.
import { describe, expect, it } from 'bun:test';

import { codexItemStatus } from './codex.js';

describe('codexItemStatus', () => {
  it('maps a commandExecution (on started) to a Bash tool line with the clean command', () => {
    const item = {
      type: 'commandExecution',
      command: "/bin/bash -lc 'ls -a'",
      commandActions: [{ type: 'listFiles', command: 'ls -a' }],
    };
    expect(codexItemStatus(item, 'started')).toEqual({ kind: 'tool', text: 'Bash', detail: 'ls -a' });
  });

  it('falls back to item.command when commandActions is absent', () => {
    expect(codexItemStatus({ type: 'commandExecution', command: 'echo hi' }, 'started')).toEqual({
      kind: 'tool',
      text: 'Bash',
      detail: 'echo hi',
    });
  });

  it('does not re-emit a command on completed (started only, to avoid duplicate lines)', () => {
    expect(codexItemStatus({ type: 'commandExecution', command: 'ls' }, 'completed')).toBeNull();
  });

  it('maps an agentMessage commentary (on completed) to a reasoning feed line', () => {
    expect(codexItemStatus({ type: 'agentMessage', phase: 'commentary', text: 'Inspecting the workspace…' }, 'completed')).toEqual(
      { kind: 'reasoning', text: 'Inspecting the workspace…', detail: null },
    );
  });

  it('ignores agentMessage commentary on started (text is empty until completed)', () => {
    expect(codexItemStatus({ type: 'agentMessage', phase: 'commentary', text: '' }, 'started')).toBeNull();
  });

  it('never surfaces the final_answer phase (that is the reply, not activity)', () => {
    expect(codexItemStatus({ type: 'agentMessage', phase: 'final_answer', text: 'Here is the answer.' }, 'completed')).toBeNull();
  });

  it('skips reasoning items (codex exposes no reasoning text under ChatGPT auth)', () => {
    expect(codexItemStatus({ type: 'reasoning', summary: [], content: [] }, 'completed')).toBeNull();
    expect(codexItemStatus({ type: 'reasoning', summary: [], content: [] }, 'started')).toBeNull();
  });

  it('maps mcpToolCall to a "Using <tool>" line with the server as detail', () => {
    expect(codexItemStatus({ type: 'mcpToolCall', server: 'github', tool: 'create_issue' }, 'started')).toEqual({
      kind: 'tool',
      text: 'create_issue',
      detail: 'github',
    });
  });

  it('maps fileChange to an Edit line with the first changed path', () => {
    expect(codexItemStatus({ type: 'fileChange', changes: [{ path: 'src/app.ts' }, { path: 'b.ts' }] }, 'started')).toEqual({
      kind: 'tool',
      text: 'Edit',
      detail: 'src/app.ts',
    });
  });

  it('maps webSearch to a WebSearch line with the query', () => {
    expect(codexItemStatus({ type: 'webSearch', query: 'codex app-server protocol' }, 'started')).toEqual({
      kind: 'tool',
      text: 'WebSearch',
      detail: 'codex app-server protocol',
    });
  });

  it('caps long commentary to a single trimmed line with an ellipsis', () => {
    const long = 'x'.repeat(500);
    const out = codexItemStatus({ type: 'agentMessage', phase: 'commentary', text: long }, 'completed');
    expect(out?.kind).toBe('reasoning');
    expect(out?.text.length).toBe(200);
    expect(out?.text.endsWith('…')).toBe(true);
  });

  it('collapses internal whitespace/newlines in commentary to one line', () => {
    const out = codexItemStatus({ type: 'agentMessage', phase: 'commentary', text: '  line one\n\n   line two  ' }, 'completed');
    expect(out?.text).toBe('line one line two');
  });

  it('returns null for unknown or shapeless items', () => {
    expect(codexItemStatus({ type: 'userMessage' }, 'completed')).toBeNull();
    expect(codexItemStatus({}, 'started')).toBeNull();
    expect(codexItemStatus(undefined, 'started')).toBeNull();
  });
});
