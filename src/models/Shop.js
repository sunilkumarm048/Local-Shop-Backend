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

    // GeoJSON Point [longitude, latitude] — order matters.
    // This is the FIXED storefront/base location set at signup. It never
    // changes from live tracking — shops always use this.
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true },
    },

    // Service providers only: their CURRENT live position, updated continuously
    // while available + app-open. Separate from `location` so a provider's
    // fixed base address is never overwritten. Customers use this (when fresh)
    // for service-provider distance; falls back to `location` if stale/absent.
    liveLocation: {
      type: { type: String, enum: ['Point'] },
      coordinates: { type: [Number] },
    },

    isOpen: { type: Boolean, default: true },

    // For service providers (plumber, electrician, AC repair, etc.): whether
    // they are currently available to take home-visit jobs right now. Mirrors a
    // delivery partner's online toggle. Ignored for normal product shops.
    availableNow: { type: Boolean, default: false },
    availableUpdatedAt: { type: Date },
    locationUpdatedAt: { type: Date },

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

    // Owner-curated photo gallery (Cloudinary CDN URLs) shown on the shop
    // detail page to attract customers. Distinct from review photos, which
    // live on the Review documents.
    gallery: { type: [String], default: [] },

    isApproved: { type: Boolean, default: false }, // admin approves new shops
    isBlocked: { type: Boolean, default: false },
  },
  { timestamps: true }
);

shopSchema.index({ location: '2dsphere' });
shopSchema.index({ name: 'text', description: 'text' });

export default mongoose.model('Shop', shopSchema);
