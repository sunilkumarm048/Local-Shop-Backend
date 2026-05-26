import mongoose from 'mongoose';

/**
 * ProductTemplate = a library entry that shop owners can clone into their
 * own store as a real Product. Lives globally (not scoped to any one shop),
 * managed by admins.
 *
 * 8d: introduced as a way to bootstrap shop catalogs. A new grocery shop
 * onboarding has to type out 50-100 SKUs manually otherwise. With templates,
 * they tick the boxes for items they sell, optionally override the suggested
 * price, and bulk-clone the lot into their store.
 *
 * The `group` field is a string label for UI grouping (Grains, Pulses, Spices,
 * Snacks, Vegetables, Toiletries, Cleaning). The `category` ObjectId is an
 * optional reference to the Category collection — used for filtering
 * templates by the shop type that would carry them.
 */
const productTemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    /** Display weight like "1 kg", "500 g", "1 L". Free text. */
    weight: { type: String, default: '' },
    /** Suggested retail price in ₹. Owner can override at clone time. */
    suggestedPrice: { type: Number, required: true, min: 0 },
    /** UI grouping label — Grains / Pulses / Spices / etc. */
    group: { type: String, required: true, trim: true, index: true },
    /** Optional ref to a leaf category (e.g. "Grocery / Kirana"). */
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null },
    image: { type: String, default: '' },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Index for the typical browse query: filter by group + active, sort by sortOrder.
productTemplateSchema.index({ group: 1, isActive: 1, sortOrder: 1 });

export default mongoose.model('ProductTemplate', productTemplateSchema);
  
