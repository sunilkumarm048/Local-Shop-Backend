import mongoose from 'mongoose';

/**
 * Category = product/shop category (Bakery, Grocery, Pharmacy, etc).
 * In the old Firestore schema this lived in `shops` (confusing — but that's
 * what `allCategories = catSnap.docs.map(d=>d.data())` was reading).
 */
const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    icon: String, // emoji or icon URL
    image: String,
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.model('Category', categorySchema);
