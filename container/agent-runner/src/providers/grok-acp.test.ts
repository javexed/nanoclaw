/**
 * AcpClient against a fake stdio peer — no child process, no network.
 *
 * The cases that matter are the ones measured against grok 1.0.5 and easy to
 * get wrong: history replay during session/load, and agent→client requests that
 * deadlock a turn if never answered.
 */
import { describe, it, expect } from 'bun:test';

import { AcpClient, buildGrokArgs, extractText, pickAllowOption, type AcpTransport, type AcpUpdate } from './grok-acp.js';

/** A stdio peer under test control: records our writes, injects agent lines. */
function fakePeer() {
  const written: Record<string, unknown>[] = [];
  let onLine: (line: string) => void = () => {};
  let onClose: (reason: string) => void = () => {};
  let closed = false;

  const transport: AcpTransport = {
    write: (line) => void written.push(JSON.parse(line) as Record<string, unknown>),
    onLine: (h) => void (onLine = h),
    onClose: (h) => void (onClose = h),
    close: () => void (closed = true),
  };

  return {
    transport,
    written,
    closed: () => closed,
    /** Last request we sent for `method`. */
    sent: (method: string) => written.filter((m) => m.method === method).at(-1),
    /** Reply to our request with a result. */
    reply(method: string, result: unknown) {
      const req = written.filter((m) => m.method === method).at(-1);
      onLine(JSON.stringify({ jsonrpc: '2.0', id: req?.id, result }) + '\n');
    },
    replyError(method: string, error: unknown) {
      const req = written.filter((m) => m.method === method).at(-1);
      onLine(JSON.stringify({ jsonrpc: '2.0', id: req?.id, error }) + '\n');
    },
    /** Push a session/update notification. */
    update(update: Record<string, unknown>) {
      onLine(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update } }) + '\n');
    },
    /** Push an agent→client request (agent asks us). */
    ask(id: number, method: string, params: unknown) {
      onLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    },
    raw: (s: string) => onLine(s),
    die: (reason: string) => onClose(reason),
  };
}

describe('AcpClient handshake and sessions', () => {
  it('initialize sends the protocol version and resolves with the agent result', async () => {
    const peer = fakePeer();
    const client = new AcpClient(peer.transport);

    const p = client.initialize({ fs: {} });
    expect(peer.sent('initialize')?.params).toMatchObject({ protocolVersion: 1 });

    peer.reply('initialize', { protocolVersion: 1, agentCapabilities: { loadSession: true } });
    await expect(p).resolves.toMatchObject({ agentCapabilities: { loadSession: true } });
  });

  it('newSession returns the sessionId that becomes our continuation', async () => {
    const peer = fakePeer();
    const client = new AcpClient(peer.transport);
    const p = client.newSession({ cwd: '/w' });
    peer.reply('session/new', { sessionId: 'sess-1' });
    expect(await p).toBe('sess-1');
  });

  it('newSession without a sessionId is an error, not a silent undefined', async () => {
    const peer = fakePeer();
    const client = new AcpClient(peer.transport);
    const p = client.newSession({ cwd: '/w' });
    peer.reply('session/new', {});
    await expect(p).rejects.toThrow(/no sessionId/);
  });

  it('a JSON-RPC error becomes a rejection naming the method', async () => {
    const peer = fakePeer();
    const client = new AcpClient(peer.transport);
    const p = client.prompt('s', 'hi');
    peer.replyError('session/prompt', { code: -32000, message: 'boom' });
    await expect(p).rejects.toThrow(/session\/prompt.*boom/);
  });
});

describe('history replay during session/load', () => {
  it('flags updates emitted while loading, and only those', async () => {
    const updates: AcpUpdate[] = [];
    const peer = fakePeer();
    const client = new AcpClient(peer.transport, { onUpdate: (u) => updates.push(u) });

    // Live output before any load.
    peer.update({ sessionUpdate: 'agent_message_chunk', content: { text: 'live-before' } });

    const loading = client.loadSession({ sessionId: 'sess-1', cwd: '/w' });
    // Grok replays the prior transcript BEFORE session/load returns.
    peer.update({ sessionUpdate: 'agent_message_chunk', content: { text: 'old-turn' } });
    peer.reply('session/load', {});
    await loading;

    // Output after the load is live again.
    peer.update({ sessionUpdate: 'agent_message_chunk', content: { text: 'live-after' } });

    expect(updates.map((u) => [u.text, u.replay])).toEqual([
      ['live-before', false],
      ['old-turn', true],
      ['live-after', false],
    ]);
  });

  it('a failed load still closes the replay window', async () => {
    const updates: AcpUpdate[] = [];
    const peer = fakePeer();
    const client = new AcpClient(peer.transport, { onUpdate: (u) => updates.push(u) });

    const loading = client.loadSession({ sessionId: 'gone', cwd: '/w' });
    peer.replyError('session/load', { message: 'no such session' });
    await expect(loading).rejects.toThrow();

    peer.update({ sessionUpdate: 'agent_message_chunk', content: { text: 'after-failure' } });
    expect(updates.at(-1)?.replay).toBe(false);
  });
});

describe('agent→client requests never deadlock a turn', () => {
  it('auto-approves a permission request with the allow-shaped option', async () => {
    const peer = fakePeer();
    const client = new AcpClient(peer.transport);

    peer.ask(99, 'session/request_permission', {
      options: [
        { optionId: 'reject-once', kind: 'reject' },
        { optionId: 'allow-always', kind: 'allow' },
      ],
    });

    const answer = peer.written.at(-1);
    expect(answer).toMatchObject({ id: 99, result: { outcome: { outcome: 'selected', optionId: 'allow-always' } } });
    expect(client).toBeDefined();
  });

  it('honours an onPermission override', () => {
    const peer = fakePeer();
    new AcpClient(peer.transport, { onPermission: () => 'reject-once' });
    peer.ask(7, 'session/request_permission', { options: [{ optionId: 'allow', kind: 'allow' }] });
    expect(peer.written.at(-1)).toMatchObject({ id: 7, result: { outcome: { optionId: 'reject-once' } } });
  });

  it('answers an unrecognised agent request rather than leaving it pending', () => {
    const peer = fakePeer();
    new AcpClient(peer.transport);
    peer.ask(5, 'fs/read_text_file', { path: '/x' });
    expect(peer.written.at(-1)).toMatchObject({ id: 5, result: {} });
  });
});

describe('framing', () => {
  it('reassembles a message split across chunk boundaries', () => {
    const updates: AcpUpdate[] = [];
    const peer = fakePeer();
    new AcpClient(peer.transport, { onUpdate: (u) => updates.push(u) });

    const msg = JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'split' } } },
    });
    peer.raw(msg.slice(0, 20));
    peer.raw(msg.slice(20) + '\n');

    expect(updates.map((u) => u.text)).toEqual(['split']);
  });

  it('handles several messages arriving in one chunk', () => {
    const updates: AcpUpdate[] = [];
    const peer = fakePeer();
    new AcpClient(peer.transport, { onUpdate: (u) => updates.push(u) });

    const line = (t: string) =>
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: t } } },
      }) + '\n';
    peer.raw(line('a') + line('b'));

    expect(updates.map((u) => u.text)).toEqual(['a', 'b']);
  });

  it('ignores a non-JSON banner line instead of failing the turn', async () => {
    const peer = fakePeer();
    const client = new AcpClient(peer.transport);
    const p = client.prompt('s', 'hi');
    peer.raw('Welcome to Grok!\n');
    peer.reply('session/prompt', { stopReason: 'end_turn' });
    await expect(p).resolves.toMatchObject({ stopReason: 'end_turn' });
  });

  it('drops an update with no sessionUpdate discriminator', () => {
    const updates: AcpUpdate[] = [];
    const peer = fakePeer();
    new AcpClient(peer.transport, { onUpdate: (u) => updates.push(u) });
    peer.update({ content: { text: 'orphan' } });
    expect(updates).toEqual([]);
  });
});

describe('transport death', () => {
  it('rejects every in-flight request when the process dies', async () => {
    const peer = fakePeer();
    const client = new AcpClient(peer.transport);
    const a = client.prompt('s', 'one');
    const b = client.initialize();

    peer.die('exit code 1');

    await expect(a).rejects.toThrow(/closed \(exit code 1\).*session\/prompt/);
    await expect(b).rejects.toThrow(/closed \(exit code 1\).*initialize/);
  });

  it('refuses new requests after close, and close() is idempotent', async () => {
    const peer = fakePeer();
    const client = new AcpClient(peer.transport);
    client.close();
    client.close();
    expect(peer.closed()).toBe(true);
    await expect(client.prompt('s', 'x')).rejects.toThrow(/transport closed/);
  });

  it('cancel after close is a no-op, not a throw', () => {
    const peer = fakePeer();
    const client = new AcpClient(peer.transport);
    client.close();
    const before = peer.written.length;
    client.cancel('s');
    expect(peer.written.length).toBe(before);
  });
});

describe('helpers', () => {
  it('extractText reads content.text, bare text, and tool titles', () => {
    expect(extractText({ content: { text: 'a' } })).toBe('a');
    expect(extractText({ text: 'b' })).toBe('b');
    expect(extractText({ title: 'run_terminal_command' })).toBe('run_terminal_command');
    expect(extractText({})).toBeUndefined();
    expect(extractText({ content: { text: '' } })).toBeUndefined();
  });

  it('pickAllowOption prefers allow, else falls back to the first option', () => {
    expect(pickAllowOption([{ optionId: 'no', kind: 'reject' }, { optionId: 'yes', kind: 'allow' }])).toBe('yes');
    expect(pickAllowOption([{ optionId: 'only' }])).toBe('only');
    expect(pickAllowOption([])).toBe('allow');
  });
});

describe('spawn shape', () => {
  it('flag order matches what the CLI accepts', () => {
    // --no-auto-update is a ROOT flag and is rejected on the subcommand;
    // --always-approve belongs to `agent`. Wrong order exits before the
    // handshake and surfaces as an unexplained transport-closed.
    expect(buildGrokArgs()).toEqual(['--no-auto-update', 'agent', '--always-approve', 'stdio']);
  });

  it('passes a model through before the stdio subcommand', () => {
    expect(buildGrokArgs({ model: 'grok-4.6' })).toEqual([
      '--no-auto-update', 'agent', '--always-approve', '--model', 'grok-4.6', 'stdio',
    ]);
  });
});
