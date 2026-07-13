import mongoose from 'mongoose';

/**
 * Singleton config doc for platform-wide feature flags.
 * Use `AppConfig.getCurrent()` to fetch (creates default on first call).
 * Admin Settings tab is the only thing that writes this.
 *
 * Flags:
 *   - showAllProducts: when false, the customer home page hides the
 *     "All Products" feed (shops strip stays visible). Temporary kill
 *     switch while catalogs are being cleaned up.
 */
const appConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'app', unique: true }, // forces singleton
    flags: {
      showAllProducts: { type: Boolean, default: true },
    },
  },
  { timestamps: true }
);

appConfigSchema.statics.getCurrent = async function () {
  let doc = await this.findOne({ key: 'app' });
  if (!doc) doc = await this.create({ key: 'app' });
  return doc;
};

export default mongoose.model('AppConfig', appConfigSchema);
