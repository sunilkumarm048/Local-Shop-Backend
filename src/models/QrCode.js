import mongoose from 'mongoose';

/**
 * QR-code registry for printed flyers.
 *
 * Workflow:
 *   1. Admin pre-generates a batch of codes (e.g. 0001..1000). Each is printed
 *      on an identical flyer design, with its `code` shown in small text.
 *   2. Each flyer's QR encodes:  <SITE>/q/<code>
 *   3. After a shop is registered + approved, the admin links a code to that
 *      shop (sets `shop`). Scanning that flyer then redirects to the shop page.
 *   4. Unlinked codes (shop = null) show a friendly "not assigned yet" page.
 *
 * `code` is a short, URL-safe public identifier printed on the flyer — NOT a
 * Mongo _id. We keep them zero-padded strings ("0001") so they sort/print
 * nicely and are easy to read off a sticker.
 */
const qrCodeSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    // The shop this code currently points to. Null = unassigned ("blank").
    shop: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Shop',
      default: null,
    },
    // Optional human note for the admin (e.g. "given to Sarala parlour 8 Jun").
    note: { type: String, trim: true },
    // How many times this code has been scanned (simple analytics).
    scans: { type: Number, default: 0 },
    lastScannedAt: { type: Date },
  },
  { timestamps: true }
);

export default mongoose.model('QrCode', qrCodeSchema);
