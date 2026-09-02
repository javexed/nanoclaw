/**
 * What happens when a Grok credential can no longer be renewed.
 *
 * The 6-hour access token is renewed by the sweep in grok-auth.ts and nobody
 * ever sees it happen. This file is about the other case: the REFRESH token
 * itself is dead — revoked, expired, or rotated out from under us — and no
 * amount of retrying will bring it back. That needs a human with a browser.
 *
 * Until now the entire user-facing surface for that was a single `log.warn`.
 * The install went quiet, and the first anyone knew of it was a raw ACP 401
 * blob appearing in a room. Expiry is not an error the software can absorb;
 * it is a request for human action, and it has to be delivered like one.
 *
 * Two halves, deliberately split:
 *
 *   - THIS file decides a failure is terminal, picks a human, and sends the
 *     message. It works on an install with no UI at all.
 *   - A PROMPTER, registered by whatever surface can actually run a device
 *     login, upgrades that message from "go and reconnect" to a URL and a
 *     code the reader can use on the phone already in their hand. With none
 *     registered the notice still goes out — it just costs a trip to a
 *     desktop.
 *
 * The prompter is a registration rather than an import because the device
 * flow spawns a container and lives in the webchat overlay, which this tree
 * must not depend on. Every other channel gets the same notice for free.
 */

import { getDeliveryAdapter } from '../delivery.js';
import { log } from '../log.js';
import { pickApprovalDelivery, pickApprover } from '../modules/approvals/primitive.js';

/**
 * A device-login prompt: where to go and what to type.
 *
 * `expiresInMs` is a DURATION, not a timestamp, because it is rendered into a
 * sentence a human reads ("good for about 12 minutes") rather than stored or
 * compared. A duration also survives the trip through a chat platform without
 * anyone having to reason about which timezone the install is in.
 */
export interface ReauthPrompt {
  verificationUrl: string;
  userCode: string;
  expiresInMs?: number;
}

export type ReauthPrompter = () => Promise<ReauthPrompt | null>;

let prompter: ReauthPrompter | null = null;

/**
 * Supply the device-login starter. Pass null to remove it.
 *
 * Last registration wins; there is deliberately no list. Two prompters would
 * mean two device codes for one outage, and the second would silently
 * invalidate the first.
 */
export function registerGrokReauthPrompter(fn: ReauthPrompter | null): void {
  prompter = fn;
}

/**
 * How often one credential may generate a notice while it stays broken.
 *
 * The sweep runs every 5 minutes, so without a floor here a dead credential
 * would DM someone twelve times an hour and teach them to mute the channel —
 * which costs more than the original silence did. An hour is long enough not
 * to nag and short enough that a code that expired unused is replaced.
 */
export const NOTICE_COOLDOWN_MS = 60 * 60_000;

/** Last successful notice per credential label. Cleared when it comes back. */
const lastNotice = new Map<string, number>();

/**
 * Is this failure worth waking a human for?
 *
 * `refreshCredentials` throws with the HTTP status in the message. A 400, 401
 * or 403 from a token endpoint means the grant is gone: revoked, already
 * rotated, or belonging to a session that ended. Retrying cannot fix any of
 * those, and only a person can.
 *
 * Everything else — a 5xx, a 429, a DNS failure, a timeout — is the network
 * having a bad minute. The sweep will pick it up on the next pass. DMing
 * someone about a blip is exactly how a notification channel trains its
 * reader to ignore it, so those stay in the log where they belong.
 */
export function isTerminalRefreshFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/invalid_grant|invalid_client|unauthorized_client/i.test(msg)) return true;
  const m = /HTTP (\d{3})/.exec(msg);
  if (!m) return false;
  const status = Number(m[1]);
  return status === 400 || status === 401 || status === 403;
}

/**
 * A credential renewed successfully — disarm the cooldown.
 *
 * Without this a reconnect inside the cooldown window would leave the next,
 * genuinely new outage waiting up to an hour for its notice.
 */
export function noteCredentialRenewed(label: string): void {
  lastNotice.delete(label);
}

/**
 * A credential failed to renew. Notifies at most once per cooldown, and only
 * for failures a human can actually do something about.
 */
export async function noteCredentialRefreshFailed(
  label: string,
  err: unknown,
  now: number = Date.now(),
): Promise<void> {
  if (!isTerminalRefreshFailure(err)) return;
  const previous = lastNotice.get(label);
  if (previous !== undefined && now - previous < NOTICE_COOLDOWN_MS) return;

  const delivered = await deliverReauthNotice(label);
  // Only a delivered notice starts the clock. A host that has not finished
  // starting, or an approver with no DM yet, must be retried on the next tick
  // rather than silently costing an hour.
  if (delivered) lastNotice.set(label, now);
}

/** `shared` | `group <id>` — the labels listCredentialOwners() produces. */
function agentGroupIdFromLabel(label: string): string | null {
  const m = /^group (.+)$/.exec(label);
  return m ? m[1] : null;
}

async function runPrompter(): Promise<ReauthPrompt | null> {
  if (!prompter) return null;
  try {
    return await prompter();
  } catch (err) {
    // A broken prompter must never swallow the notice: the whole point is
    // that someone finds out. Degrade to the no-code wording.
    log.warn('Grok re-auth prompter failed; sending the notice without a code', { err });
    return null;
  }
}

export function buildReauthNotice(label: string, prompt: ReauthPrompt | null): string {
  const groupId = agentGroupIdFromLabel(label);
  const whose = groupId ? `Agent group ${groupId}` : 'This install';
  const head =
    `⚠️ Grok sign-in expired.\n\n${whose} cannot reach Grok until it is reconnected. ` +
    `Agents on the Grok provider will fail every turn until then.`;

  if (!prompt) {
    return (
      `${head}\n\nReconnect from Settings → Grok in the webchat, or run this on the host:\n` +
      `  pnpm exec tsx setup/index.ts --step provider-auth grok`
    );
  }

  const mins = prompt.expiresInMs ? Math.max(1, Math.round(prompt.expiresInMs / 60_000)) : null;
  const validity = mins
    ? `\n\nThe code is good for about ${mins} minute${mins === 1 ? '' : 's'}. ` +
      `If it expires before you get to it, the next check sends a fresh one.`
    : '';
  return (
    `${head}\n\nTo reconnect from this device:\n` +
    `1. Open ${prompt.verificationUrl}\n` +
    `2. Enter the code ${prompt.userCode}${validity}`
  );
}

/** Returns true only when a message actually reached someone. */
async function deliverReauthNotice(label: string): Promise<boolean> {
  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('Grok re-auth notice deferred: no delivery adapter yet', { label });
    return false;
  }

  const approvers = await pickApprover(agentGroupIdFromLabel(label));
  if (approvers.length === 0) {
    log.warn('Grok re-auth notice undeliverable: no eligible approver', { label });
    return false;
  }

  // No origin channel to prefer — a credential does not belong to a
  // conversation. First approver with a reachable DM wins.
  const target = await pickApprovalDelivery(approvers, '');
  if (!target) {
    log.warn('Grok re-auth notice undeliverable: no DM channel for any approver', {
      label,
      approvers,
    });
    return false;
  }

  // Started only once we know there is somewhere to send it: the prompter
  // spawns a container, and a device code nobody can be told about is pure
  // cost. It also means the code is minted fresh at delivery time rather than
  // burning part of its life waiting on a DM lookup.
  const prompt = await runPrompter();

  try {
    await adapter.deliver(
      target.messagingGroup.channel_type,
      target.messagingGroup.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({ text: buildReauthNotice(label, prompt) }),
      undefined,
      // ensureUserDm may resolve through a named instance; dispatch is
      // exact-key, so the notice must be addressed to the instance that owns
      // the conversation or it cannot be posted at all.
      target.messagingGroup.instance,
    );
  } catch (err) {
    log.error('Grok re-auth notice delivery failed', { label, to: target.userId, err });
    return false;
  }

  log.info('Grok re-auth notice delivered', {
    label,
    to: target.userId,
    withCode: prompt !== null,
  });
  return true;
}

/** Test seam — drops the prompter and every cooldown. */
export function __resetGrokReauthState(): void {
  prompter = null;
  lastNotice.clear();
}
