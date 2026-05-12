import { Router } from 'express';
import { z } from 'zod';
import { Shop, Product, Category } from '../models/index.js';
import { optionalAuth } from '../middleware/auth.js';
import { validateBody } from '../utils/validate.js';

const router = Router();

/**
 * GET /api/shops
 *   ?lng=&lat=    if present, return shops within radius (km) sorted by distance
 *   ?radiusKm=5   default 5
 *   ?category=    filter by category id
 *   ?q=           text search (name/description)
 *
 * If no lng/lat, returns all approved shops (paginated).
 */
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const { lng, lat, radiusKm = '5', category, q, limit = '50', skip = '0' } = req.query;

    const filter = { isApproved: true, isBlocked: false };
    if (category) filter.category = category;
    if (q) filter.$text = { $search: String(q) };

    let cursor;
    if (lng && lat) {
      // $nearSphere needs a 2dsphere index (declared in Shop.js)
      filter.location = {
        $nearSphere: {
          $geometry: { type: 'Point', coordinates: [Number(lng), Number(lat)] },
          $maxDistance: Number(radiusKm) * 1000, // metres
        },
      };
      cursor = Shop.find(filter);
    } else {
      cursor = Shop.find(filter).sort({ createdAt: -1 });
    }

    const shops = await cursor.limit(Number(limit)).skip(Number(skip)).lean();
    res.json({ shops });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/shops/categories — list all active categories
 */
router.get('/categories', async (_req, res, next) => {
  try {
    const categories = await Category.find({ isActive: true }).sort({ sortOrder: 1 }).lean();
    res.json({ categories });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/shops/:id — single shop detail
 */
router.get('/:id', async (req, res, next) => {
  try {
    const shop = await Shop.findById(req.params.id).populate('category').lean();
    if (!shop || shop.isBlocked) return res.status(404).json({ error: 'Shop not found' });
    res.json({ shop });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/shops/:id/products — products of a shop
 */
router.get('/:id/products', async (req, res, next) => {
  try {
    const products = await Product.find({
      shop: req.params.id,
      isActive: true,
    }).lean();
    res.json({ products });
  } catch (err) {
    next(err);
  }
});

export default router;
