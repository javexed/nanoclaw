/**
 * Web Push fan-out for webchat.
 *
 * Sends a push notification to every subscription that isn't the sender's
 * own (so the user who just typed doesn't get pinged for their own message).
 * Endpoints are allow-listed against known push services to block authenticated
 * callers from pointing the host at internal IPs (SSRF via sendNotification).
 */
import webPush from 'web-push';

import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import { deleteWebchatPushSubscriptionByEndpoint, type WebchatPushSubscription } from './db.js';

let webPushReady = false;

const PUSH_HOSTS_ALLOW = [
  /\.push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /\.notify\.windows\.com$/,
];

export function isValidPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  return PUSH_HOSTS_ALLOW.some((re) => re.test(u.hostname));
}

export function initWebPush(): void {
  const pub = process.env.WEBCHAT_VAPID_PUBLIC_KEY;
  const priv = process.env.WEBCHAT_VAPID_PRIVATE_KEY;
  const sub = process.env.WEBCHAT_VAPID_SUBJECT || 'mailto:admin@example.com';
  if (!pub || !priv) {
    log.warn('Webchat: VAPID keys missing — Web Push disabled');
    return;
  }
  webPush.setVapidDetails(sub, pub, priv);
  webPushReady = true;
  log.info('Webchat: Web Push initialized');
}

export interface BroadcastPushMsg {
  roomId: string;
  roomName: string;
  sender: string;
  content: string;
  messageId?: string;
}

function getSubscriptionsExcludingIdentity(identity: string): WebchatPushSubscription[] {
  return getDb()
    .prepare(`SELECT * FROM webchat_push_subscriptions WHERE identity != ?`)
    .all(identity) as WebchatPushSubscription[];
}

export async function sendPushForMessage(m: BroadcastPushMsg): Promise<void> {
  if (!webPushReady) {
    log.debug('Webchat push: skipped (not ready)', { sender: m.sender });
    return;
  }
  const subs = getSubscriptionsExcludingIdentity(m.sender);
  if (subs.length === 0) return;

  const payload = JSON.stringify({
    title: `${m.sender} · ${m.roomName}`,
    body: (m.content || '').slice(0, 160),
    roomId: m.roomId,
    messageId: m.messageId,
    tag: `room-${m.roomId}`,
  });

  await Promise.all(
    subs.map(async (row) => {
      try {
        const keys = JSON.parse(row.keys_json) as { p256dh: string; auth: string };
        const res = await webPush.sendNotification({ endpoint: row.endpoint, keys }, payload, { TTL: 60 });
        log.debug('Webchat push: delivered', { endpointTail: row.endpoint.slice(-24), status: res.statusCode });
      } catch (err: unknown) {
        // 404/410 = subscription revoked on the device; prune it.
        const e = err as { statusCode?: number; message?: string; body?: string };
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          deleteWebchatPushSubscriptionByEndpoint(row.endpoint);
          log.info('Webchat push: pruned dead subscription', { endpointTail: row.endpoint.slice(-24) });
        } else {
          log.warn('Webchat push: send failed', {
            err: e?.message,
            statusCode: e?.statusCode,
            endpointTail: row.endpoint.slice(-24),
          });
        }
      }
    }),
  );
}
