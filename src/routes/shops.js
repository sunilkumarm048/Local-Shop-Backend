import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';

import { Shop, Product, Category } from '../models/index.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/role.js';
import { validateBody } from '../utils/validate.js';
import { HttpError } from '../middleware/error.js';

const router = Router();

// ---------- helpers ----------

/**
 * Confirm the authenticated user is the owner of the given shop.
 * Returns the shop document (non-lean — caller may mutate + save).
 * Throws 404 if missing, 403 if not the owner.
 */
async function assertShopOwner(req, shopId) {
  const shop = await Shop.findById(shopId);
  if (!shop) throw new HttpError(404, 'Shop not found');
  if (shop.owner.toString() !== req.user._id.toString()) {
    throw new HttpError(403, 'You do not own this shop');
  }
  return shop;
}

/**
 * Slugify a shop name for the URL-safe `slug` field. Appends a 4-char random
 * suffix so two "Anand General Store" shops can coexist.
 */
function makeSlug(name) {
  const base = String(name || 'shop')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'shop';
  const suffix = crypto.randomBytes(2).toString('hex');
  return `${base}-${suffix}`;
}

// ============================================================
// PUBLIC ROUTES (customer-facing)
// ============================================================

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
      filter.location = {
        $nearSphere: {
          $geometry: { type: 'Point', coordinates: [Number(lng), Number(lat)] },
          $maxDistance: Number(radiusKm) * 1000,
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

// ============================================================
// OWNER ROUTES — must be declared BEFORE any /:id route so that
// /mine isn't captured by the param matcher.
// ============================================================

const createShopSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().max(500).optional(),
  phone: z.string().trim().min(10).max(20).optional(),
  logo: z.string().url().optional().or(z.literal('')),
  coverImage: z.string().url().optional().or(z.literal('')),
  category: z.string().optional(), // category ObjectId
  address: z.object({
    line1: z.string().min(1).max(120),
    line2: z.string().max(120).optional(),
    city: z.string().min(1).max(60),
    state: z.string().min(1).max(60),
    pincode: z.string().min(4).max(10),
  }),
  location: z.object({
    lng: z.number().min(-180).max(180),
    lat: z.number().min(-90).max(90),
  }),
  openingHours: z
    .array(
      z.object({
        day: z.number().int().min(0).max(6),
        open: z.string().regex(/^\d{2}:\d{2}$/),
        close: z.string().regex(/^\d{2}:\d{2}$/),
      })
    )
    .optional(),
});

/**
 * POST /api/shops — create a shop for the current user.
 * Only callable by users who hold the 'shop' role.
 *
 * Auto-approves for now (isApproved: true). When the admin dashboard ships
 * in Phase 6, flip this back to `false` and require manual approval.
 */
router.post('/', requireAuth, requireRole('shop'), async (req, res, next) => {
  try {
    const data = validateBody(req, createShopSchema);

    // Optional: cap at one shop per owner for now. Lift this in Phase 6 if needed.
    const existing = await Shop.countDocuments({ owner: req.user._id });
    if (existing >= 1) {
      throw new HttpError(409, 'You already have a shop. Edit it instead of creating another.');
    }

    const shop = await Shop.create({
      name: data.name,
      slug: makeSlug(data.name),
      owner: req.user._id,
      ownerEmail: req.user.email,
      description: data.description,
      phone: data.phone,
      logo: data.logo || undefined,
      coverImage: data.coverImage || undefined,
      category: data.category || undefined,
      address: data.address,
      location: {
        type: 'Point',
        coordinates: [data.location.lng, data.location.lat],
      },
      openingHours: data.openingHours,
      isOpen: true,
      isApproved: true, // TODO: Phase 6 — set false and gate behind admin approval
    });

    // Live-join the owner's socket(s) to this shop's room so they receive
    // order events without waiting for a reconnect.
    const io = req.app.get('io');
    if (io) {
      const sockets = await io.in(`user:${req.user._id}`).fetchSockets();
      for (const s of sockets) s.join(`shop:${shop._id}`);
    }

    res.status(201).json({ shop });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/shops/mine — shops owned by the current user.
 */
router.get('/mine', requireAuth, requireRole('shop'), async (req, res, next) => {
  try {
    const shops = await Shop.find({ owner: req.user._id })
      .populate('category')
      .lean();
    res.json({ shops });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// PUBLIC ROUTES with :id (must come after /mine)
// ============================================================

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
 * GET /api/shops/:id/products — active products of a shop (customer view)
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

// ============================================================
// OWNER-ONLY MUTATIONS on a specific shop / its products
// ============================================================

const updateShopSchema = createShopSchema.partial().extend({
  isOpen: z.boolean().optional(),
});

/**
 * PATCH /api/shops/:id — owner edits their own shop
 */
router.patch('/:id', requireAuth, requireRole('shop'), async (req, res, next) => {
  try {
    const data = validateBody(req, updateShopSchema);
    const shop = await assertShopOwner(req, req.params.id);

    // Apply only fields actually sent
    if (data.name !== undefined) shop.name = data.name;
    if (data.description !== undefined) shop.description = data.description;
    if (data.phone !== undefined) shop.phone = data.phone;
    if (data.logo !== undefined) shop.logo = data.logo || undefined;
    if (data.coverImage !== undefined) shop.coverImage = data.coverImage || undefined;
    if (data.category !== undefined) shop.category = data.category || undefined;
    if (data.address !== undefined) {
      shop.address = { ...(shop.address || {}), ...data.address };
    }
    if (data.location !== undefined) {
      shop.location = {
        type: 'Point',
        coordinates: [data.location.lng, data.location.lat],
      };
    }
    if (data.openingHours !== undefined) shop.openingHours = data.openingHours;
    if (data.isOpen !== undefined) shop.isOpen = data.isOpen;

    await shop.save();
    res.json({ shop });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/shops/:id/products/all — ALL products (including inactive) for owner.
 * Public route GET /:id/products only returns active=true.
 */
router.get(
  '/:id/products/all',
  requireAuth,
  requireRole('shop'),
  async (req, res, next) => {
    try {
      await assertShopOwner(req, req.params.id);
      const products = await Product.find({ shop: req.params.id })
        .sort({ createdAt: -1 })
        .lean();
      res.json({ products });
    } catch (err) {
      next(err);
    }
  }
);

const productSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).optional(),
  image: z.string().url().optional().or(z.literal('')),
  category: z.string().optional(),
  price: z.number().min(0),
  mrp: z.number().min(0).optional(),
  stock: z.number().int().min(0).default(0),
  inStock: z.boolean().optional(),
  weight: z.string().max(20).optional(),
});

/**
 * POST /api/shops/:id/products — create product in this shop
 */
router.post(
  '/:id/products',
  requireAuth,
  requireRole('shop'),
  async (req, res, next) => {
    try {
      const data = validateBody(req, productSchema);
      const shop = await assertShopOwner(req, req.params.id);

      const product = await Product.create({
        shop: shop._id,
        shopEmail: shop.ownerEmail,
        name: data.name,
        description: data.description,
        image: data.image || undefined,
        category: data.category || undefined,
        price: data.price,
        mrp: data.mrp,
        stock: data.stock,
        inStock: data.inStock ?? data.stock > 0,
        weight: data.weight || '',
        isActive: true,
      });

      res.status(201).json({ product });
    } catch (err) {
      next(err);
    }
  }
);

const productUpdateSchema = productSchema.partial().extend({
  isActive: z.boolean().optional(),
});

/**
 * PATCH /api/shops/:id/products/:productId
 */
router.patch(
  '/:id/products/:productId',
  requireAuth,
  requireRole('shop'),
  async (req, res, next) => {
    try {
      const data = validateBody(req, productUpdateSchema);
      await assertShopOwner(req, req.params.id);

      const product = await Product.findOne({
        _id: req.params.productId,
        shop: req.params.id,
      });
      if (!product) throw new HttpError(404, 'Product not found');

      for (const key of Object.keys(data)) {
        if (key === 'image') product.image = data.image || undefined;
        else if (key === 'category') product.category = data.category || undefined;
        else product[key] = data[key];
      }
      // Keep inStock in sync with stock unless explicitly overridden
      if (data.stock !== undefined && data.inStock === undefined) {
        product.inStock = product.stock > 0;
      }
      await product.save();

      res.json({ product });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * DELETE /api/shops/:id/products/:productId
 *
 * Soft delete: sets isActive=false. This preserves historical order references
 * (orders embed `name`/`price`/`image` at checkout time, but we still need the
 * product doc to exist for the populate calls in the order detail page).
 */
router.delete(
  '/:id/products/:productId',
  requireAuth,
  requireRole('shop'),
  async (req, res, next) => {
    try {
      await assertShopOwner(req, req.params.id);
      const result = await Product.updateOne(
        { _id: req.params.productId, shop: req.params.id },
        { $set: { isActive: false, inStock: false } }
      );
      if (result.matchedCount === 0) throw new HttpError(404, 'Product not found');
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
