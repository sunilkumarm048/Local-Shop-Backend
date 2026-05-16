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

    // Live location — updated via Socket.IO, persisted on disconnect.
    //
    // We deliberately do NOT set a default here. A freshly-signed-up partner
    // has no GPS fix yet, so the entire `currentLocation` field is omitted
    // until their first location ping. Combined with the `sparse: true` flag
    // on the 2dsphere index below, MongoDB simply skips these docs in the
    // index rather than choking on a half-formed Point with no coordinates.
    currentLocation: {
      type: { type: String, enum: ['Point'] },
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

// `sparse: true` is critical — without it, Mongo tries to index every doc on
// `currentLocation`, and a doc whose currentLocation is missing or has no
// `coordinates` array throws "Can't extract geo keys / Point must be an array
// or object, instead got type missing" on any read that touches the field.
deliveryProfileSchema.index({ currentLocation: '2dsphere' }, { sparse: true });
deliveryProfileSchema.index({ available: 1, vehicleType: 1 });

export default mongoose.model('DeliveryProfile', deliveryProfileSchema);
