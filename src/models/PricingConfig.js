import mongoose from 'mongoose';

/**
 * Singleton config doc for platform-wide pricing.
 * Use `PricingConfig.getCurrent()` to fetch (creates default on first call).
 * Admin pricing page is the only thing that writes this.
 */
const pricingConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'pricing', unique: true }, // forces singleton
    vehicles: {
      bike: {
        id: { type: String, default: 'bike' },
        name: String,
        icon: String,
        maxKg: Number,
        perKmRate: Number,
        minFee: Number,
      },
      '3wheeler': {
        id: { type: String, default: '3wheeler' },
        name: String,
        icon: String,
        maxKg: Number,
        perKmRate: Number,
        minFee: Number,
      },
      tataAce: {
        id: { type: String, default: 'tataAce' },
        name: String,
        icon: String,
        maxKg: Number,
        perKmRate: Number,
        minFee: Number,
      },
      pickup8ft: {
        id: { type: String, default: 'pickup8ft' },
        name: String,
        icon: String,
        maxKg: Number,
        perKmRate: Number,
        minFee: Number,
      },
      tata407: {
        id: { type: String, default: 'tata407' },
        name: String,
        icon: String,
        maxKg: Number,
        perKmRate: Number,
        minFee: Number,
      },
    },
    handlingFee: { type: Number, default: 5 },
    platformFeePercent: { type: Number, default: 5 },
    globalDiscount: {
      enabled: { type: Boolean, default: false },
      type: { type: String, enum: ['percent', 'flat'], default: 'percent' },
      value: { type: Number, default: 0 },
      label: { type: String, default: '' },
    },
  },
  { timestamps: true }
);

const DEFAULTS = {
  vehicles: {
    bike:       { id: 'bike',      name: '2-Wheeler',  icon: '🛵', maxKg: 10,   perKmRate: 10, minFee: 30  },
    '3wheeler': { id: '3wheeler',  name: '3-Wheeler',  icon: '🛺', maxKg: 500,  perKmRate: 14, minFee: 100 },
    tataAce:    { id: 'tataAce',   name: 'Tata Ace',   icon: '🚐', maxKg: 750,  perKmRate: 18, minFee: 200 },
    pickup8ft:  { id: 'pickup8ft', name: 'Pickup 8ft', icon: '🚛', maxKg: 1250, perKmRate: 22, minFee: 300 },
    tata407:    { id: 'tata407',   name: 'Tata 407',   icon: '🚚', maxKg: 2500, perKmRate: 30, minFee: 500 },
  },
  handlingFee: 5,
  platformFeePercent: 5,
  globalDiscount: { enabled: false, type: 'percent', value: 0, label: '' },
};

pricingConfigSchema.statics.getCurrent = async function () {
  let doc = await this.findOne({ key: 'pricing' });
  if (!doc) doc = await this.create({ key: 'pricing', ...DEFAULTS });
  return doc;
};

export default mongoose.model('PricingConfig', pricingConfigSchema);
