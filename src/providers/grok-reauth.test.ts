/**
 * Grok re-auth notification.
 *
 * Two properties carry this file. A dead credential must reach a human ONCE
 * per outage — not never (the bug this replaces) and not every five minutes
 * (the bug a naive fix introduces). And a failure the software can recover
 * from on its own must never reach anyone at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const deliver = vi.fn(async (...args: unknown[]): Promise<string | undefined> => {
  void args;
  return 'platform-msg-1';
});
let adapter: { deliver: typeof deliver } | null = { deliver };
let approvers: string[] = ['discord:owner'];
let deliveryTarget: unknown = {
  userId: 'discord:owner',
  messagingGroup: { channel_type: 'discord', platform_id: 'dm-1', instance: 'discord' },
};

vi.mock('../delivery.js', () => ({ getDeliveryAdapter: () => adapter }));
vi.mock('../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../modules/approvals/primitive.js', () => ({
  pickApprover: async () => approvers,
  pickApprovalDelivery: async () => deliveryTarget,
}));

const {
  NOTICE_COOLDOWN_MS,
  __resetGrokReauthState,
  buildReauthNotice,
  isTerminalRefreshFailure,
  noteCredentialRefreshFailed,
  noteCredentialRenewed,
  registerGrokReauthPrompter,
} = await import('./grok-reauth.js');

/** The text the adapter was handed, unwrapped from the chat-sdk envelope. */
const sentText = (call = 0): string => JSON.parse(String(deliver.mock.calls[call][4])).text as string;

beforeEach(() => {
  __resetGrokReauthState();
  deliver.mockClear();
  adapter = { deliver };
  approvers = ['discord:owner'];
  deliveryTarget = {
    userId: 'discord:owner',
    messagingGroup: { channel_type: 'discord', platform_id: 'dm-1', instance: 'discord' },
  };
});

describe('isTerminalRefreshFailure', () => {
  it('treats a dead grant as terminal', () => {
    expect(isTerminalRefreshFailure(new Error('grok token refresh failed: HTTP 400 invalid_grant'))).toBe(true);
    expect(isTerminalRefreshFailure(new Error('grok token refresh failed: HTTP 401 nope'))).toBe(true);
    expect(isTerminalRefreshFailure(new Error('grok token refresh failed: HTTP 403 nope'))).toBe(true);
  });

  it('treats anything retryable as NOT terminal', () => {
    // 429 is the trap: it is a 4xx, and it is exactly the case where DMing
    // someone is both useless and guaranteed to repeat.
    expect(isTerminalRefreshFailure(new Error('grok token refresh failed: HTTP 429 slow down'))).toBe(false);
    expect(isTerminalRefreshFailure(new Error('grok token refresh failed: HTTP 503 upstream'))).toBe(false);
    expect(isTerminalRefreshFailure(new Error('fetch failed: ECONNREFUSED'))).toBe(false);
  });
});

describe('noteCredentialRefreshFailed', () => {
  const dead = new Error('grok token refresh failed: HTTP 400 invalid_grant');

  it('delivers one notice for a dead credential', async () => {
    await noteCredentialRefreshFailed('shared', dead, 0);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(sentText()).toContain('Grok sign-in expired');
  });

  it('says nothing at all for a retryable failure', async () => {
    await noteCredentialRefreshFailed('shared', new Error('HTTP 503 upstream'), 0);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('stays quiet for the rest of the cooldown', async () => {
    await noteCredentialRefreshFailed('shared', dead, 0);
    // The sweep runs every 5 minutes; walk a full hour of them.
    for (let t = 5 * 60_000; t < NOTICE_COOLDOWN_MS; t += 5 * 60_000) {
      await noteCredentialRefreshFailed('shared', dead, t);
    }
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('speaks again once the cooldown has passed', async () => {
    await noteCredentialRefreshFailed('shared', dead, 0);
    await noteCredentialRefreshFailed('shared', dead, NOTICE_COOLDOWN_MS);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('re-arms immediately when the credential comes back', async () => {
    await noteCredentialRefreshFailed('shared', dead, 0);
    noteCredentialRenewed('shared');
    await noteCredentialRefreshFailed('shared', dead, 60_000);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('tracks each credential separately', async () => {
    await noteCredentialRefreshFailed('shared', dead, 0);
    await noteCredentialRefreshFailed('group alpha', dead, 0);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(sentText(1)).toContain('Agent group alpha');
  });

  it('retries next tick when nothing could be delivered yet', async () => {
    // A host still starting up has no adapter. That must not burn the hour —
    // otherwise a restart during an outage buys 60 minutes of silence.
    adapter = null;
    await noteCredentialRefreshFailed('shared', dead, 0);
    expect(deliver).not.toHaveBeenCalled();

    adapter = { deliver };
    await noteCredentialRefreshFailed('shared', dead, 5 * 60_000);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('does not start a device login when there is nobody to tell', async () => {
    approvers = [];
    const prompter = vi.fn(async () => ({ verificationUrl: 'https://x.ai/d', userCode: 'ABCD-1234' }));
    registerGrokReauthPrompter(prompter);
    await noteCredentialRefreshFailed('shared', dead, 0);
    // The prompter spawns a container. A code nobody can be told about is
    // pure cost.
    expect(prompter).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('the prompter', () => {
  const dead = new Error('grok token refresh failed: HTTP 400 invalid_grant');

  it('puts the URL and code in the message', async () => {
    registerGrokReauthPrompter(async () => ({
      verificationUrl: 'https://x.ai/device',
      userCode: 'ABCD-1234',
      expiresInMs: 15 * 60_000,
    }));
    await noteCredentialRefreshFailed('shared', dead, 0);
    const text = sentText();
    expect(text).toContain('https://x.ai/device');
    expect(text).toContain('ABCD-1234');
    expect(text).toContain('about 15 minutes');
  });

  it('still delivers a notice when the prompter throws', async () => {
    registerGrokReauthPrompter(async () => {
      throw new Error('docker unavailable');
    });
    await noteCredentialRefreshFailed('shared', dead, 0);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(sentText()).toContain('Settings → Grok');
  });

  it('falls back to the manual wording with no prompter registered', () => {
    expect(buildReauthNotice('shared', null)).toContain('provider-auth grok');
  });
});
