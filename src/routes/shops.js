import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';

import { Shop, Product, Category, ProductTemplate } from '../models/index.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/role.js';
import { validateBody } from '../utils/validate.js';
import { HttpError } from '../middleware/error.js';
import { shopAnalytics } from '../services/analytics.js';

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

    const hasGeo = lng && lat;
    const term = q ? String(q).trim() : '';

    // MongoDB forbids $text and $nearSphere in the same query. So:
    //   - with a location: match name/description by regex (combines with geo)
    //   - without a location: use the faster $text index
    if (term) {
      if (hasGeo) {
        // Match name/description by regex (combines with $nearSphere, unlike
        // $text). Match if ANY word appears — so "Sonu Sweets" still finds a
        // shop named just "Sonu". Escape regex special chars per word.
        const words = term
          .split(/\s+/)
          .filter(Boolean)
          .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const clauses = [];
        for (const w of words) {
          clauses.push({ name: { $regex: w, $options: 'i' } });
          clauses.push({ description: { $regex: w, $options: 'i' } });
        }
        if (clauses.length) filter.$or = clauses;
      } else {
        filter.$text = { $search: term };
      }
    }

    let cursor;
    if (hasGeo) {
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
 * GET /api/shops/categories — list all active categories.
 *
 * 8b: pass `?tree=true` to get a nested response:
 *   { categories: [{ ...parent, children: [...] }] }
 *
 * Default (no tree param) returns a flat list for backward compatibility
 * with anything that hasn't migrated yet.
 */
router.get('/categories', async (req, res, next) => {
  try {
    const all = await Category.find({ isActive: true })
      .sort({ sortOrder: 1, name: 1 })
      .lean();

    if (req.query.tree !== 'true') {
      return res.json({ categories: all });
    }

    // Build the tree: parents (parent=null) get a children[] array of
    // categories that reference them.
    const byParent = new Map();
    for (const c of all) {
      const key = c.parent ? String(c.parent) : null;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(c);
    }
    const tops = byParent.get(null) || [];
    const tree = tops.map((p) => ({
      ...p,
      children: byParent.get(String(p._id)) || [],
    }));
    // Orphans (parent points to an inactive/missing category) — surface
    // them at the top level so they're still findable; otherwise they'd
    // silently disappear from the UI.
    const knownTopIds = new Set(tops.map((t) => String(t._id)));
    const orphans = [];
    for (const [parentKey, list] of byParent.entries()) {
      if (parentKey === null) continue;
      if (!knownTopIds.has(parentKey)) {
        // Their parent doesn't exist in the active set
        for (const c of list) orphans.push({ ...c, children: [] });
      }
    }

    res.json({ categories: [...tree, ...orphans] });
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
 * As of Phase 6a, new shops are created with `isApproved: false` and are
 * hidden from the customer-facing GET /shops until an admin approves them
 * via PATCH /api/admin/shops/:id/approve.
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
      isApproved: false, // Phase 6a — gated by admin approval
    });

    // Respond immediately — the shop is saved. Socket side-effects below are
    // best-effort and must NEVER block or delay the HTTP response. (A slow or
    // disconnected Socket.io/Redis adapter on fetchSockets() was leaving the
    // create request hanging, so the client spinner never stopped even though
    // the shop was created.)
    res.status(201).json({ shop });

    // Fire-and-forget: live-join the owner's socket(s) to this shop's room and
    // notify admins. Wrapped so any failure here is logged, not thrown.
    (async () => {
      try {
        const io = req.app.get('io');
        if (!io) return;
        const sockets = await io.in(`user:${req.user._id}`).fetchSockets();
        for (const s of sockets) s.join(`shop:${shop._id}`);
        io.to('admins').emit('admin:new_shop', {
          shopId: shop._id.toString(),
          name: shop.name,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[shops] post-create socket side-effect failed (non-blocking):', err.message);
      }
    })();
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

/**
 * GET /api/shops/mine/analytics?days=30 — analytics for the caller's first
 * shop. If they own multiple, the `shopId` query param chooses which one;
 * otherwise we default to the first one we find.
 *
 * Returns:
 *   {
 *     range: { from, to, days },
 *     summary: { totalOrders, totalRevenue, avgOrderValue, completionRate, delivered },
 *     series: [{ day: 'YYYY-MM-DD', orders, revenue }],   // dense, one per day
 *     topProducts: [{ name, qty, revenue }],
 *   }
 */
router.get('/mine/analytics', requireAuth, requireRole('shop'), async (req, res, next) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
    const shopIdFilter = { owner: req.user._id };
    if (req.query.shopId) shopIdFilter._id = req.query.shopId;

    const shop = await Shop.findOne(shopIdFilter).select('_id name').lean();
    if (!shop) throw new HttpError(404, 'No shop found for this user');

    const data = await shopAnalytics({ shopId: shop._id, days });
    res.json({ shop: { _id: shop._id, name: shop.name }, ...data });
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

const gallerySchema = z.object({
  gallery: z.array(z.string().url()).max(12),
});

/**
 * PUT /api/shops/:id/gallery — owner replaces their shop's photo gallery.
 * Send the full desired array (add/remove/reorder handled client-side).
 * Capped at 12 images.
 */
router.put(
  '/:id/gallery',
  requireAuth,
  requireRole('shop'),
  async (req, res, next) => {
    try {
      const data = validateBody(req, gallerySchema);
      const shop = await assertShopOwner(req, req.params.id);
      shop.gallery = data.gallery;
      await shop.save();
      res.json({ shop });
    } catch (err) {
      next(err);
    }
  }
);

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

// ============================================================
// PHASE 8d — Clone from product templates
// ============================================================

const bulkCloneSchema = z.object({
  items: z
    .array(
      z.object({
        templateId: z.string().regex(/^[a-f0-9]{24}$/i),
        // Optional overrides — fall back to template values if omitted.
        price: z.number().nonnegative().optional(),
        stock: z.number().int().min(0).optional(),
      })
    )
    .min(1)
    .max(200),
});

/**
 * POST /api/shops/:id/products/from-templates — bulk-clone templates into shop.
 *
 * Body: { items: [{ templateId, price?, stock? }] }
 *
 * For each item we look up the template, then create a Product owned by the
 * shop with template values + caller overrides. Duplicates (same template
 * already cloned into this shop) are skipped — we identify by name match
 * within the shop. The response includes counts of created vs skipped.
 *
 * Not transactional — if 50 out of 100 inserts succeed and then the DB
 * connection drops, the first 50 stick. Acceptable for a non-critical
 * convenience feature; user can re-click and the dedupe will skip the
 * already-created ones.
 */
router.post(
  '/:id/products/from-templates',
  requireAuth,
  requireRole('shop'),
  async (req, res, next) => {
    try {
      const data = validateBody(req, bulkCloneSchema);
      const shop = await assertShopOwner(req, req.params.id);

      const templateIds = data.items.map((i) => i.templateId);
      const templates = await ProductTemplate.find({
        _id: { $in: templateIds },
        isActive: true,
      }).lean();
      const tplById = new Map(templates.map((t) => [String(t._id), t]));

      // Avoid duplicates by checking existing product names in this shop.
      const existing = await Product.find({ shop: shop._id })
        .select('name')
        .lean();
      const existingNames = new Set(existing.map((p) => p.name.toLowerCase()));

      const toCreate = [];
      const skipped = [];
      for (const item of data.items) {
        const tpl = tplById.get(item.templateId);
        if (!tpl) {
          skipped.push({ templateId: item.templateId, reason: 'template not found' });
          continue;
        }
        if (existingNames.has(tpl.name.toLowerCase())) {
          skipped.push({ templateId: item.templateId, reason: 'product with same name already in shop' });
          continue;
        }
        const stock = typeof item.stock === 'number' ? item.stock : 0;
        toCreate.push({
          shop: shop._id,
          shopEmail: shop.ownerEmail,
          name: tpl.name,
          description: '',
          image: tpl.image || undefined,
          category: tpl.category || undefined,
          price: typeof item.price === 'number' ? item.price : tpl.suggestedPrice,
          stock,
          inStock: stock > 0,
          weight: tpl.weight || '',
          isActive: true,
        });
      }

      const created = toCreate.length > 0 ? await Product.insertMany(toCreate) : [];
      res.status(201).json({
        created: created.length,
        createdProducts: created,
        skipped,
      });
    } catch (err) {
      next(err);
    }
  }
);

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
