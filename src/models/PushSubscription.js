import mongoose from 'mongoose';

/**
 * A single browser/device Web Push subscription belonging to a user.
 *
 * One user can have many subscriptions (phone + laptop + work machine), so
 * we key uniquely on `endpoint` (the per-browser push URL). When a push fails
 * with 404/410 (subscription expired or revoked), the sender prunes that doc.
 */
const pushSubscriptionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // The browser's push endpoint URL — unique per device/browser.
    endpoint: { type: String, required: true, unique: true },
    // VAPID encryption keys the browser generated for this subscription.
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    userAgent: { type: String, default: '' },
    lastUsedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export default mongoose.model('PushSubscription', pushSubscriptionSchema);
  
