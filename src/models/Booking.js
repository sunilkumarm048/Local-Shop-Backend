import mongoose from 'mongoose';

/**
 * Booking = a customer's request for a home-visit service from a provider
 * (plumber, electrician, AC repair, salon, etc.).
 *
 * This is intentionally SEPARATE from the product Order model: a service
 * booking has no cart, no quantities, no price, and no payment. Mixing the two
 * would pollute every Order query and the delivery flow with "is this a product
 * or a service?" branches. Keeping a dedicated collection keeps both clean.
 *
 * No money fields by design — price is arranged offline between customer and
 * provider. The platform only handles discovery + scheduling + status tracking.
 */

const BOOKING_STATUSES = [
  'requested',
  'accepted',
  'scheduled',
  'on_the_way',
  'in_progress',
  'completed',
  'declined',
  'cancelled',
];

const bookingSchema = new mongoose.Schema(
  {
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    provider: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Shop',
      required: true,
      index: true,
    },

    serviceName: { type: String, required: true, trim: true },
    serviceCategory: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },

    scheduledDate: { type: Date },
    scheduledSlot: { type: String, trim: true },
    requestNow: { type: Boolean, default: false },

    address: {
      label: String,
      line1: String,
      line2: String,
      city: String,
      state: String,
      pincode: String,
      location: {
        type: { type: String, enum: ['Point'], default: 'Point' },
        coordinates: { type: [Number] },
      },
    },

    contactName: { type: String, trim: true },
    contactPhone: { type: String, trim: true },
    notes: { type: String, trim: true, maxlength: 1000 },

    status: {
      type: String,
      enum: BOOKING_STATUSES,
      default: 'requested',
      index: true,
    },
    statusHistory: [
      {
        status: { type: String, enum: BOOKING_STATUSES },
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        note: String,
        _id: false,
      },
    ],

    cancelReason: { type: String, trim: true },
    review: { type: mongoose.Schema.Types.ObjectId, ref: 'Review' },
    completedAt: Date,
  },
  { timestamps: true }
);

bookingSchema.index({ provider: 1, status: 1, createdAt: -1 });
bookingSchema.index({ customer: 1, createdAt: -1 });

bookingSchema.statics.STATUSES = BOOKING_STATUSES;

export default mongoose.model('Booking', bookingSchema);
