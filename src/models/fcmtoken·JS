import mongoose from 'mongoose';

/**
 * A native-app (Android/Capacitor) FCM device token belonging to a user.
 *
 * Mirrors PushSubscription but for Firebase Cloud Messaging: one user can
 * have many devices, keyed uniquely on the token string. When an FCM send
 * fails with "unregistered", the sender prunes the dead token.
 */
const fcmTokenSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    token: { type: String, required: true, unique: true },
    platform: { type: String, default: 'android' },
    lastUsedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export default mongoose.model('FcmToken', fcmTokenSchema);
