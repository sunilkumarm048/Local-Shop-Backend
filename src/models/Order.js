import mongoose from 'mongoose';

/**
 * Order = a single shop's portion of a customer's checkout.
 * If a customer's cart spans multiple shops, we create one Order per shop,
 * all linked by `cartId`. The old codebase called those "split-orders" —
 * we unify into the same collection here, with `isSplit` flagging multi-shop carts.
 */

const orderItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    name: String,        // snapshot
    price: Number,       // snapshot at order time
    qty: { type: Number, required: true, min: 1 },
    weight: String,
    image: String,
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    cartId: { type: String, index: true }, // groups split orders from one checkout

    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
    shopEmail: { type: String, lowercase: true }, // legacy compat for fast lookup

    items: [orderItemSchema],

    // Money breakdown — server is the source of truth, do not trust client values
    subtotal: { type: Number, required: true },
    discount: {
      amount: { type: Number, default: 0 },
      label: String,
      source: { type: String, enum: ['shop', 'global', 'none'], default: 'none' },
    },
    handlingFee: { type: Number, default: 0 },
    platformFee: { type: Number, default: 0 },
    deliveryFee: { type: Number, default: 0 },
    total: { type: Number, required: true },

    // Delivery details
    deliveryMode: { type: String, enum: ['delivery', 'pickup'], default: 'delivery' },
    vehicleId: String, // bike | 3wheeler | tataAce | pickup8ft | tata407
    distanceKm: Number,

    recipient: {
      name: String,
      phone: String,
      address: String,
      location: {
        type: { type: String, enum: ['Point'], default: 'Point' },
        coordinates: { type: [Number] },
      },
    },

    // Lifecycle
    status: {
      type: String,
      enum: [
        'pending_payment',
        'placed',
        'accepted',
        'preparing',
        'ready_for_pickup',
        'picked_up',
        'out_for_delivery',
        'delivered',
        'cancelled',
        'refunded',
      ],
      default: 'pending_payment',
      index: true,
    },
    statusHistory: [
      {
        status: String,
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        note: String,
        _id: false,
      },
    ],

    // Assignment
    deliveryPartner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },

    // Payment
    payment: {
      method: { type: String, enum: ['razorpay', 'cod'], default: 'razorpay' },
      razorpayOrderId: String,
      razorpayPaymentId: String,
      razorpaySignature: String,
      paidAt: Date,
      status: {
        type: String,
        enum: ['pending', 'paid', 'failed', 'refunded'],
        default: 'pending',
      },
    },

    isSplit: { type: Boolean, default: false }, // true if cart spanned >1 shop

    placedAt: Date,
    deliveredAt: Date,
  },
  { timestamps: true }
);

orderSchema.index({ shop: 1, status: 1, createdAt: -1 });
orderSchema.index({ customer: 1, createdAt: -1 });
orderSchema.index({ deliveryPartner: 1, status: 1 });

export default mongoose.model('Order', orderSchema);
