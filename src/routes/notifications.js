import { Router } from 'express';
import { z } from 'zod';

import { PushSubscription, FcmToken } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { validateBody } from '../utils/validate.js';
import {
  isPushEnabled,
  getVapidPublicKey,
  sendPushToUser,
} from '../services/push.js';

const router = Router();

/**
 * GET /api/notifications/vapid-public-key
 * Public — the browser needs the VAPID public key before it can subscribe.
 * `enabled:false` tells the frontend push isn't configured, so it hides the
 * "enable notifications" UI gracefully.
 */
router.get('/vapid-public-key', (_req, res) => {
  res.json({ enabled: isPushEnabled(), publicKey: getVapidPublicKey() });
});

const subscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({
      p256dh: z.string().min(1),
      auth: z.string().min(1),
    }),
  }),
  userAgent: z.string().max(500).optional(),
});

/**
 * POST /api/notifications/subscribe
 * Upsert the caller's browser subscription (keyed by endpoint). Re-subscribing
 * the same browser just refreshes the record.
 */
router.post('/subscribe', requireAuth, async (req, res, next) => {
  try {
    const { subscription, userAgent } = validateBody(req, subscribeSchema);
    await PushSubscription.findOneAndUpdate(
      { endpoint: subscription.endpoint },
      {
        $set: {
          user: req.user._id,
          endpoint: subscription.endpoint,
          keys: subscription.keys,
          userAgent: userAgent || '',
          lastUsedAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});


const fcmTokenSchema = z.object({
  token: z.string().min(10).max(4096),
  platform: z.string().max(32).optional(),
});

/**
 * POST /api/notifications/fcm-token
 * Register (or refresh) a native-app FCM device token for the caller.
 * Upserts on token so re-registering after app restart is idempotent, and
 * re-assigns the token if a different account signs in on the same device.
 */
router.post('/fcm-token', requireAuth, async (req, res, next) => {
  try {
    const { token, platform } = validateBody(req, fcmTokenSchema);
    await FcmToken.findOneAndUpdate(
      { token },
      { user: req.user._id, platform: platform || 'android', lastUsedAt: new Date() },
      { upsert: true, setDefaultsOnInsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const unsubscribeSchema = z.object({ endpoint: z.string().url() });

/**
 * POST /api/notifications/unsubscribe
 * Remove one browser subscription. Only deletes if it belongs to the caller.
 */
router.post('/unsubscribe', requireAuth, async (req, res, next) => {
  try {
    const { endpoint } = validateBody(req, unsubscribeSchema);
    await PushSubscription.deleteOne({ endpoint, user: req.user._id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/notifications/test — send the caller a real test alert through
 * every configured channel (socket, web push, FCM). Lets a provider verify
 * the app's ring end-to-end from inside the app.
 */
router.post('/test', requireAuth, async (req, res, next) => {
  try {
    await sendPushToUser(req.user._id, {
      title: '🔔 Test alert',
      body: 'Ring check — if you hear the order sound, alerts are working!',
      url: '/shop',
      tag: 'test-alert',
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
