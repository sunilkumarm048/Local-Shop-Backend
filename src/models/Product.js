import mongoose from 'mongoose';

const productSchema = new mongoose.Schema(
  {
    shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
    shopEmail: { type: String, lowercase: true, trim: true }, // legacy compat

    name: { type: String, required: true, trim: true },
    description: String,
    image: String,
    images: [String],

    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },

    price: { type: Number, required: true, min: 0 },         // current sell price in INR
    mrp: { type: Number, min: 0 },                            // strike-through
    stock: { type: Number, default: 0, min: 0 },
    inStock: { type: Boolean, default: true },

    // Weight string like "500g", "1kg", "12pcs" — parsed by weight-utils on the client
    // for delivery-vehicle selection. Kept as a string for backwards compatibility.
    weight: { type: String, default: '' },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

productSchema.index({ shop: 1, isActive: 1 });
productSchema.index({ name: 'text', description: 'text' });

export default mongoose.model('Product', productSchema);
