import mongoose from 'mongoose';

/**
 * Review = one customer's rating + optional written review + photos for a shop.
 *
 * One review per customer per shop (enforced by the unique compound index
 * below). Editing a review updates the same document rather than creating a
 * new one — the route layer upserts on (customer, shop).
 *
 * Eligibility (who may post) is enforced in the route, not here:
 *   - product shops: only customers with a delivered order from that shop
 *   - service shops: any logged-in customer
 * We keep that policy in the route because it needs to look at Orders and the
 * shop's category, which would make this model heavy and circular.
 *
 * Whenever a review is created, edited, or deleted, the route recomputes the
 * parent Shop's `rating` (avg) and `ratingCount` so the customer-facing cards
 * and lists stay in sync without a join.
 */
const reviewSchema = new mongoose.Schema(
  {
    shop: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Shop',
      required: true,
      index: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // Denormalized so we can render "— Sonali D." without populating User.
    customerName: { type: String, trim: true },

    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, trim: true, maxlength: 1000, default: '' },

    // Customer-uploaded photos (Cloudinary CDN URLs).
    photos: {
      type: [String],
      default: [],
      validate: {
        validator: (arr) => arr.length <= 6,
        message: 'A review can have at most 6 photos',
      },
    },
  },
  { timestamps: true }
);

// One review per customer per shop. Editing upserts on this pair.
reviewSchema.index({ shop: 1, customer: 1 }, { unique: true });
// Fast "latest reviews for this shop" listing.
reviewSchema.index({ shop: 1, createdAt: -1 });

export default mongoose.model('Review', reviewSchema);
