import mongoose from 'mongoose';

/**
 * DeliveryProfile = role-specific data for users with role "delivery".
 * Keeps the User schema lean and lets us index location separately for
 * "find nearest online driver" queries.
 *
 * Replaces the old `delivery` collection (which was keyed by email).
 */
const deliveryProfileSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },

    available: { type: Boolean, default: false, index: true },

    // Live location — updated via Socket.IO, persisted on disconnect
    currentLocation: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number] }, // [lng, lat]
      updatedAt: Date,
    },

    vehicleType: { type: String, enum: ['bike', '3wheeler', 'tataAce', 'pickup8ft', 'tata407'] },
    vehicleNumber: String,
    licenseNumber: String,

    documents: {
      drivingLicenseUrl: String,
      aadhaarUrl: String,
      vehicleRcUrl: String,
      verified: { type: Boolean, default: false },
    },

    // Wallet (earnings - withdrawals)
    walletBalance: { type: Number, default: 0 },
    totalEarnings: { type: Number, default: 0 },
    totalDeliveries: { type: Number, default: 0 },

    rating: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0 },

    bankDetails: {
      accountName: String,
      accountNumber: String,
      ifsc: String,
      upiId: String,
    },
  },
  { timestamps: true }
);

deliveryProfileSchema.index({ currentLocation: '2dsphere' });
deliveryProfileSchema.index({ available: 1, vehicleType: 1 });

export default mongoose.model('DeliveryProfile', deliveryProfileSchema);
