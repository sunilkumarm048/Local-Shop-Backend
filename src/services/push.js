import webpush from 'web-push';

import { env } from '../config/env.js';
import { PushSubscription, FcmToken } from '../models/index.js';

// ---- Firebase Cloud Messaging (native Android app) ------------------------
// Initialized lazily from the FIREBASE_SERVICE_ACCOUNT env var (full service
// account JSON as a string). If unset or firebase-admin isn't installed,
// FCM is skipped silently and web push continues to work as before.
let fcmMessaging = null;
async function initFcm() {
  if (fcmMessaging || !env.FIREBASE_SERVICE_ACCOUNT) return;
  try {
    const admin = (await import('firebase-admin')).default;
    const credentials = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(credentials) });
    }
    fcmMessaging = admin.messaging();
    console.log('[push] FCM enabled (native app notifications)');
  } catch (err) {
    console.error('[push] FCM init failed — native push disabled:', err.message);
  }
}
initFcm();

/**
 * Web Push sender + in-app socket notifier.
 *
 * This module was referenced across the codebase (orders, payments, delivery,
 * autoAssign) but had gone missing — its absence is what crashed boot. It does
 * two things on every notification:
 *
 *   1. Emits a `notification` socket event to `user:<id>` so the in-app toast
 *      / sound fires for anyone who happens to be online. This works with or
 *      without browser push permission, and needs no VAPID keys.
 *
 *   2. If VAPID keys are configured, sends a real Web Push to every browser
 *      subscription the user has registered — so they get an OS-level
 *      notification even when the tab is closed. Dead subscriptions (410/404)
 *      are pruned automatically.
 *
 * If VAPID keys are NOT set, step 2 is skipped silently. The app keeps working;
 * it just won't deliver background push. Generate keys once with:
 *     npx web-push generate-vapid-keys
 * then set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT.
 */

const pushEnabled = Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

if (pushEnabled) {
  webpush.setVapidDetails(
    env.VAPID_SUBJECT || 'mailto:admin@local-shop.app',
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY
  );
  console.log('[push] Web Push enabled (VAPID configured)');
} else {
  console.log(
    '[push] Web Push disabled (no VAPID keys) — in-app socket notifications only'
  );
}

/** Whether browser push is configured. Routes use this for the status endpoint. */
export function isPushEnabled() {
  return pushEnabled;
}

export function getVapidPublicKey() {
  return env.VAPID_PUBLIC_KEY || null;
}

// ---- socket bridge -------------------------------------------------------
// Route handlers that call sendPushToUser don't have the io instance, so we
// stash it here once at startup (server.js calls setPushIO after sockets init).
let io = null;
export function setPushIO(instance) {
  io = instance;
}

// ---- main API ------------------------------------------------------------

/**
 * Notify a user. Safe to call from anywhere; never throws (errors are logged
 * so a failed notification can't break an order/payment flow).
 *
 * @param {string|ObjectId} userId
 * @param {{title:string, body:string, tag?:string, url?:string, orderId?:string}} payload
 */
export async function sendPushToUser(userId, payload) {
  if (!userId) return;
  const id = userId.toString();

  // 1. In-app socket toast — fire-and-forget, works without push permission.
  try {
    io?.to(`user:${id}`).emit('notification', payload);
  } catch (err) {
    console.error('[push] socket emit failed:', err.message);
  }

  // 2. Native app (FCM) — rings the custom order sound even when the app is
  // closed, via the "order_alerts" channel baked into the APK.
  sendFcmToUser(id, payload).catch((err) =>
    console.error('[push] fcm send failed:', err.message)
  );

  // 3. Browser Web Push — only if configured.
  if (!pushEnabled) return;

  let subs;
  try {
    subs = await PushSubscription.find({ user: id }).lean();
  } catch (err) {
    console.error('[push] could not load subscriptions:', err.message);
    return;
  }
  if (!subs.length) return;

  const notification = JSON.stringify({
    title: payload.title,
    body: payload.body,
    tag: payload.tag,
    url: payload.url || '/',
    orderId: payload.orderId,
  });

  const deadEndpoints = [];

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          notification,
          { urgency: 'high', TTL: 3600 }
        );
      } catch (err) {
        // 404/410 = subscription gone (user cleared site data, etc.) — prune it.
        if (err.statusCode === 404 || err.statusCode === 410) {
          deadEndpoints.push(sub.endpoint);
        } else {
          console.error(
            `[push] send failed (${err.statusCode || '?'}):`,
            err.body || err.message
          );
        }
      }
    })
  );

  if (deadEndpoints.length) {
    try {
      await PushSubscription.deleteMany({ endpoint: { $in: deadEndpoints } });
    } catch {
      /* best effort cleanup */
    }
  }
}

// ---- FCM sender ------------------------------------------------------------

/**
 * Send an FCM notification to every native-app device a user has registered.
 * Uses a "notification" message with channel_id "order_alerts" so Android
 * displays it via the custom-ring channel even when the app is fully closed.
 * Dead tokens (uninstalled app) are pruned automatically.
 */
async function sendFcmToUser(userId, payload) {
  if (!fcmMessaging) return;

  let tokens;
  try {
    tokens = await FcmToken.find({ user: userId }).lean();
  } catch (err) {
    console.error('[push] could not load fcm tokens:', err.message);
    return;
  }
  if (!tokens.length) return;

  const message = {
    notification: {
      title: payload.title,
      body: payload.body,
    },
    data: {
      url: payload.url || '/',
      ...(payload.orderId ? { orderId: String(payload.orderId) } : {}),
    },
    android: {
      priority: 'high',
      notification: {
        channelId: 'order_alerts', // the custom-ring channel in MainActivity
        sound: 'shop_new_order',
        defaultVibrateTimings: false,
        vibrateTimingsMillis: [0, 400, 200, 400, 200, 400],
        priority: 'max',
        visibility: 'public',
        ...(payload.tag ? { tag: payload.tag } : {}),
      },
    },
  };

  const deadTokens = [];
  await Promise.all(
    tokens.map(async (t) => {
      try {
        await fcmMessaging.send({ ...message, token: t.token });
      } catch (err) {
        const code = err?.errorInfo?.code || err?.code || '';
        if (
          code.includes('registration-token-not-registered') ||
          code.includes('invalid-argument')
        ) {
          deadTokens.push(t.token);
        } else {
          console.error('[push] fcm send error:', code || err.message);
        }
      }
    })
  );

  if (deadTokens.length) {
    try {
      await FcmToken.deleteMany({ token: { $in: deadTokens } });
    } catch {
      /* best effort cleanup */
    }
  }
}
  
