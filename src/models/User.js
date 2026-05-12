import mongoose from 'mongoose';

/**
 * Unified user model. The `role` field gates which dashboards a user can access.
 * A single user can in principle hold multiple roles (e.g. shop owner who also
 * orders as a customer) — represented as an array.
 *
 * Auth methods used: any combination of email/password, phone OTP, Google OAuth.
 * `passwordHash` is only set if they signed up with email/password.
 * `phoneVerified` flips true after a successful OTP check.
 * `oauthProviders` keeps Google subject IDs so we can link logins.
 */
const userSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    email: { type: String, lowercase: true, trim: true, sparse: true, unique: true },
    phone: { type: String, trim: true, sparse: true, unique: true },

    passwordHash: { type: String, select: false },
    phoneVerified: { type: Boolean, default: false },
    emailVerified: { type: Boolean, default: false },

    oauthProviders: [
      {
        provider: { type: String, enum: ['google'], required: true },
        providerId: { type: String, required: true },
        _id: false,
      },
    ],

    roles: {
      type: [String],
      enum: ['customer', 'shop', 'delivery', 'admin'],
      default: ['customer'],
    },

    // Default delivery address — full address book lives in `addresses`
    addresses: [
      {
        label: String,
        line1: String,
        line2: String,
        city: String,
        state: String,
        pincode: String,
        location: {
          type: { type: String, enum: ['Point'], default: 'Point' },
          coordinates: { type: [Number], default: undefined }, // [lng, lat]
        },
      },
    ],

    avatar: String,
    isBlocked: { type: Boolean, default: false },
    lastLoginAt: Date,
  },
  { timestamps: true }
);

userSchema.index({ 'addresses.location': '2dsphere' });
userSchema.index({ roles: 1 });

export default mongoose.model('User', userSchema);
