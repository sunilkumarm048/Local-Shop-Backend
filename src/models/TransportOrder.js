import mongoose from 'mongoose';

/**
 * Transport order = a bare logistics booking (no shop, no products).
 * Customer picks vehicle + pickup + drop. Maps to old `transport-orders`.
 */
const transportOrderSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    deliveryPartner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },

    vehicleId: { type: String, required: true }, // bike | 3wheeler | tataAce | ...

    pickup: {
      name: String,
      phone: String,
      address: String,
      location: {
        type: { type: String, enum: ['Point'], default: 'Point' },
        coordinates: { type: [Number], required: true },
      },
    },
    drop: {
      name: String,
      phone: String,
      address: String,
      location: {
        type: { type: String, enum: ['Point'], default: 'Point' },
        coordinates: { type: [Number], required: true },
      },
    },

    distanceKm: Number,
    estimatedWeightKg: Number,
    notes: String,

    fee: { type: Number, required: true },
    platformFee: { type: Number, default: 0 },
    total: { type: Number, required: true },

    status: {
      type: String,
      enum: [
        'pending_payment',
        'placed',
        'accepted',
        'picked_up',
        'in_transit',
        'delivered',
        'cancelled',
      ],
      default: 'pending_payment',
      index: true,
    },
    statusHistory: [
      {
        status: String,
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        _id: false,
      },
    ],

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

    placedAt: Date,
    deliveredAt: Date,
  },
  { timestamps: true }
);

transportOrderSchema.index({ 'pickup.location': '2dsphere' });
transportOrderSchema.index({ 'drop.location': '2dsphere' });

export default mongoose.model('TransportOrder', transportOrderSchema);
