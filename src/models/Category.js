import mongoose from 'mongoose';

/**
 * Category = shop / product category.
 *
 * 8b: now supports a single level of nesting via `parent`. Top-level groups
 * (Food & Daily Need, Household, etc.) have `parent = null`. Leaves point
 * to their parent. We deliberately limit to one level — multi-level
 * hierarchies in marketplaces almost always end up confusing and rarely
 * help users. If you genuinely need deeper nesting later, it's a small
 * change (just relax the parent depth check).
 *
 * The unique index on `name` is global (not scoped to parent), so you can't
 * have two "Bakery" categories under different parents. This is intentional —
 * shop owners type the category name, and two different "Bakery"s would be
 * confusing. If two parents need a child of the same conceptual name, prefix
 * the parent (e.g. "Bakery (Food)" vs "Bakery (Industrial)").
 */
const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    icon: String, // emoji or icon URL
    image: String,
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    // 8b: nesting. null for top-level groups, ObjectId for children.
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      default: null,
      index: true,
    },
  },
  { timestamps: true }
);

export default mongoose.model('Category', categorySchema);
