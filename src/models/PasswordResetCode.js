import mongoose from 'mongoose';

/**
 * Password-reset OTP codes, stored in MongoDB (NOT Redis).
 *
 * We use MongoDB rather than Redis for this because the reset flow must be
 * reliable, and Redis on the current host has been unstable (ECONNRESET).
 * MongoDB is the always-on primary store, so the reset won't hang on a flaky
 * cache connection.
 *
 * `expiresAt` has a TTL index — MongoDB auto-deletes expired codes, so we get
 * Redis-like expiry without Redis. One active code per email (we upsert).
 */
const passwordResetCodeSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, unique: true },
    code: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// TTL index: Mongo removes the doc once expiresAt passes.
passwordResetCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('PasswordResetCode', passwordResetCodeSchema);
