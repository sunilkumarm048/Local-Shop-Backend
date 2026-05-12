import { Router } from 'express';
import { z } from 'zod';

import { Product, PricingConfig } from '../models/index.js';
import { optionalAuth } from '../middleware/auth.js';
import { validateBody } from '../utils/validate.js';
import { calculateOrderTotals, distanceKm } from '../services/pricing.js';
import { HttpError } from '../middleware/error.js';

const router = Router();

const quoteSchema = z.object({
  items: z
    .array(z.object({ productId: z.string(), qty: z.number().int().min(1) }))
    .min(1),
  dropLocation: z.object({ lng: z.number(), lat: z.number() }).optional(),
  vehicleId: z.enum(['bike', '3wheeler', 'tataAce', 'pickup8ft', 'tata407']).default('bike'),
});

/**
 * POST /api/quotes/order
 *
 * Compute per-shop totals for a cart without creating anything. The cart page
 * calls this on every change so the customer sees the real fee before paying.
 * The result is informational — the authoritative number is recomputed at checkout.
 */
router.post('/order', optionalAuth, async (req, res, next) => {
  try {
    const data = validateBody(req, quoteSchema);

    const productIds = data.items.map((i) => i.productId);
    const products = await Product.find({ _id: { $in: productIds }, isActive: true }).populate(
      'shop'
    );
    if (products.length !== productIds.length) {
      throw new HttpError(400, 'One or more products are unavailable');
    }

    // Group by shop
    const byShop = new Map();
    for (const item of data.items) {
      const p = products.find((x) => x._id.toString() === item.productId);
      const shopId = p.shop._id.toString();
      if (!byShop.has(shopId)) byShop.set(shopId, { shop: p.shop, items: [] });
      byShop.get(shopId).items.push({
        price: p.price,
        qty: item.qty,
        name: p.name,
        weight: p.weight,
      });
    }

    const dropPoint = data.dropLocation
      ? [data.dropLocation.lng, data.dropLocation.lat]
      : null;

    const quotes = [];
    let grandTotal = 0;
    for (const { shop, items } of byShop.values()) {
      const km =
        dropPoint && shop.location?.coordinates
          ? Number(distanceKm(shop.location.coordinates, dropPoint).toFixed(2))
          : null;

      const totals = await calculateOrderTotals({
        items,
        vehicleId: data.vehicleId,
        distanceKm: km,
        shop,
      });

      quotes.push({
        shopId: shop._id.toString(),
        shopName: shop.name,
        ...totals,
      });
      grandTotal += totals.total;
    }

    res.json({ quotes, grandTotal });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/quotes/pricing-config — used by admin pricing page (Phase 6)
 * Also useful for the customer side to render vehicle options.
 */
router.get('/pricing-config', async (_req, res, next) => {
  try {
    const cfg = await PricingConfig.getCurrent();
    res.json({ config: cfg });
  } catch (err) {
    next(err);
  }
});

export default router;
