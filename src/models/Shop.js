import mongoose from 'mongoose';

/**
 * Shop = one merchant storefront. Maps to the old `localshop-details` collection.
 * Geo-indexed so we can answer "shops within 5km of customer".
 */
const shopSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, lowercase: true, trim: true, unique: true, sparse: true },

    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    ownerEmail: { type: String, lowercase: true, trim: true }, // denormalized for legacy queries

    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', index: true },

    phone: String,
    description: String,
    coverImage: String,
    logo: String,

    address: {
      line1: String,
      line2: String,
      city: String,
      state: String,
      pincode: String,
    },

    // GeoJSON Point [longitude, latitude] — order matters
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true },
    },

    isOpen: { type: Boolean, default: true },
    openingHours: [
      {
        day: { type: Number, min: 0, max: 6 }, // 0 = Sunday
        open: String,  // "09:00"
        close: String, // "21:00"
        _id: false,
      },
    ],

    // Per-shop discount that overrides the global one (kept compatible with old shape)
    discount: {
      enabled: { type: Boolean, default: false },
      type: { type: String, enum: ['percent', 'flat'], default: 'percent' },
      value: { type: Number, default: 0 },
      label: { type: String, default: '' },
    },

    rating: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0 },

    isApproved: { type: Boolean, default: false }, // admin approves new shops
    isBlocked: { type: Boolean, default: false },
  },
  { timestamps: true }
);

shopSchema.index({ location: '2dsphere' });
shopSchema.index({ name: 'text', description: 'text' });

export default mongoose.model('Shop', shopSchema);
