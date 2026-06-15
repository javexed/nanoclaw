/**
 * Tests for the backtick-escape behavior in engage-pattern matching.
 *
 * The router strips markdown code regions (fenced and inline) before
 * running each wiring's engage_pattern. This stops operators (and
 * agents) from accidentally triggering other agents by quoting handles
 * in setup messages, task prompts, code samples, etc.
 *
 * What's tested:
 *   - Bare handles still match.
 *   - Single-backtick inline `@handle` does NOT match.
 *   - Triple-backtick fenced ``` @handle ``` does NOT match.
 *   - Mixed quoted + bare handles → only the bare one matches.
 *   - Unbalanced backticks fall through (fail-open).
 *   - The `stripCodeRegions` helper has the expected text-mangling semantics.
 */
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import type { InboundEvent } from './channels/adapter.js';
import { stripCodeRegions } from './router.js';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-backtick' };
});

const TEST_DIR = '/tmp/nanoclaw-test-backtick';
const now = () => new Date().toISOString();

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: 'ag-advisor', name: 'Advisor', folder: 'advisor', agent_provider: null, created_at: now() });
  createAgentGroup({ id: 'ag-news', name: 'News', folder: 'news', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-floor',
    channel_type: 'webchat',
    platform_id: 'floor',
    name: 'floor',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  // Mention-only patterns (case-insensitive char-class form, the canonical output of ciFolderToken)
  createMessagingGroupAgent({
    id: 'mga-advisor',
    messaging_group_id: 'mg-floor',
    agent_group_id: 'ag-advisor',
    engage_mode: 'pattern',
    engage_pattern: '\\B@[aA][dD][vV][iI][sS][oO][rR]\\b',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-news',
    messaging_group_id: 'mg-floor',
    agent_group_id: 'ag-news',
    engage_mode: 'pattern',
    engage_pattern: '\\B@[nN][eE][wW][sS]\\b',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

const event = (text: string): InboundEvent => ({
  channelType: 'webchat',
  platformId: 'floor',
  threadId: null,
  message: {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    content: JSON.stringify({ sender: 'Test', text }),
    timestamp: now(),
    isGroup: true,
  },
});

describe('stripCodeRegions helper', () => {
  it('strips single-backtick inline code', () => {
    expect(stripCodeRegions('hello `@advisor` world')).toBe('hello  world');
  });

  it('strips triple-backtick fenced blocks (single line)', () => {
    expect(stripCodeRegions('hello ```@advisor``` world')).toBe('hello  world');
  });

  it('strips triple-backtick fenced blocks (multi-line)', () => {
    const input = 'before\n```\n@advisor inside fence\n```\nafter';
    expect(stripCodeRegions(input)).toBe('before\n\nafter');
  });

  it('strips multiple inline spans on one line', () => {
    expect(stripCodeRegions('`a` and `@b` and `@c`')).toBe(' and  and ');
  });

  it('leaves unbalanced backticks untouched (fail-open)', () => {
    expect(stripCodeRegions('opening ` then @advisor unclosed')).toBe('opening ` then @advisor unclosed');
  });

  it('leaves bare text unchanged', () => {
    expect(stripCodeRegions('plain @advisor message')).toBe('plain @advisor message');
  });
});

describe('engage-pattern matching honors backtick escape', () => {
  it('bare @advisor wakes Advisor (baseline)', async () => {
    const { routeInbound } = await import('./router.js');
    const { getActiveSessions } = await import('./db/sessions.js');
    await routeInbound(event('@advisor please check AAPL'));
    const active = getActiveSessions();
    expect(active).toHaveLength(1);
    expect(active[0].agent_group_id).toBe('ag-advisor');
  });

  it('inline `@advisor` does NOT wake Advisor', async () => {
    const { routeInbound } = await import('./router.js');
    const { getActiveSessions } = await import('./db/sessions.js');
    await routeInbound(event('to address the advisor, write `@advisor` in your message'));
    expect(getActiveSessions()).toHaveLength(0);
  });

  it('fenced ```@advisor``` does NOT wake Advisor', async () => {
    const { routeInbound } = await import('./router.js');
    const { getActiveSessions } = await import('./db/sessions.js');
    await routeInbound(event('the syntax is ```@advisor``` exactly'));
    expect(getActiveSessions()).toHaveLength(0);
  });

  it('multi-line fenced block does NOT wake', async () => {
    const { routeInbound } = await import('./router.js');
    const { getActiveSessions } = await import('./db/sessions.js');
    await routeInbound(event('example:\n```\n@advisor please reply\n```\nnote the syntax'));
    expect(getActiveSessions()).toHaveLength(0);
  });

  it('mixed quoted + bare: only the bare one wakes', async () => {
    const { routeInbound } = await import('./router.js');
    const { getActiveSessions } = await import('./db/sessions.js');
    await routeInbound(event('previously `@advisor` was used. @news please weigh in.'));
    const active = getActiveSessions();
    expect(active).toHaveLength(1);
    expect(active[0].agent_group_id).toBe('ag-news');
  });

  it('the exact failure mode from the schedule_task setup is prevented', async () => {
    // The body of my @advisor setup message contained literal "@news", "@tech",
    // etc. as part of the task prompt. With the escape, wrapping each in
    // backticks would have left only @advisor as a live mention.
    const { routeInbound } = await import('./router.js');
    const { getActiveSessions } = await import('./db/sessions.js');
    await routeInbound(event('@advisor schedule a task with prompt: "review `@news` briefing, then..."'));
    const active = getActiveSessions();
    expect(active).toHaveLength(1);
    expect(active[0].agent_group_id).toBe('ag-advisor');
  });
});
