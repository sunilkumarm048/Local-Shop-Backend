import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';

import { User, Shop, Order, Booking, Category, PricingConfig, AppConfig, WithdrawRequest, DeliveryProfile, Product, ProductTemplate } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/role.js';
import { validateBody } from '../utils/validate.js';
import { HttpError } from '../middleware/error.js';
import { createShopOwnerAccount } from '../services/auth.js';

const router = Router();

/* ============================================================
 * PHASE 6a — Admin panel (backend)
 *
 * All routes require role 'admin'. Admin is granted via the ADMIN_EMAILS
 * env-var allowlist (see services/auth.js maybePromoteAdmin) — the first
 * time a user whose email matches logs in, they're auto-promoted.
 *
 * Scope of 6a:
 *   - shops: list + approve/reject + block
 *   - users: list + block/unblock
 *   - orders: list across all shops, status oversight
 *   - categories: CRUD
 *
 * Deferred to later: pricing config UI, withdrawal processing, delivery doc
 * verification, analytics dashboards.
 * ============================================================ */

// Every route below uses these.
router.use(requireAuth, requireRole('admin'));

// ============================================================
// SUMMARY
// ============================================================

/**
 * GET /api/admin/summary — counts for the admin landing page.
 * Cheap: 5 countDocuments calls in parallel.
 */
router.get('/summary', async (_req, res, next) => {
  try {
    const [
      pendingShops,
      totalShops,
      totalUsers,
      activeOrders,
      totalOrders,
    ] = await Promise.all([
      Shop.countDocuments({ isApproved: false, isBlocked: false }),
      Shop.countDocuments({ isApproved: true }),
      User.countDocuments({}),
      Order.countDocuments({
        status: { $in: ['placed', 'accepted', 'preparing', 'ready_for_pickup', 'picked_up', 'out_for_delivery'] },
      }),
      Order.countDocuments({}),
    ]);
    res.json({
      summary: { pendingShops, totalShops, totalUsers, activeOrders, totalOrders },
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// SHOPS
// ============================================================

/**
 * GET /api/admin/shops?status=pending|approved|blocked|all
 *
 * Returns shops with their owner inlined. Default: pending (the most useful
 * default for an admin landing — "what needs my attention").
 */
router.get('/shops', async (req, res, next) => {
  try {
    const { status = 'pending', q, limit = '50' } = req.query;
    const filter = {};
    if (status === 'pending') {
      filter.isApproved = false;
      filter.isBlocked = false;
    } else if (status === 'approved') {
      filter.isApproved = true;
      filter.isBlocked = false;
    } else if (status === 'blocked') {
      filter.isBlocked = true;
    }
    if (q) filter.$text = { $search: String(q) };

    const shops = await Shop.find(filter)
      .populate('owner', 'name email phone')
      .populate('category', 'name')
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 50, 200))
      .lean();

    res.json({ shops });
  } catch (err) {
    next(err);
  }
});

function adminMakeSlug(name) {
  const base =
    String(name || 'shop')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'shop';
  return `${base}-${crypto.randomBytes(2).toString('hex')}`;
}

const quickShopSchema = z.object({
  name: z.string().min(2).max(120),
  category: z.string().min(1), // category _id
  phone: z.string().min(6).max(20),
  ownerEmail: z.string().email(),
  ownerPassword: z.string().min(6).max(72),
  description: z.string().max(500).optional(),
  logo: z.string().url().optional(),
  lat: z.number(),
  lng: z.number(),
  address: z
    .object({
      line1: z.string().max(200).optional(),
      city: z.string().max(100).optional(),
      pincode: z.string().max(12).optional(),
    })
    .optional(),
});

/**
 * POST /api/admin/shops/quick-create
 *
 * Field-onboarding tool: lets an admin/agent list a shop ON BEHALF of a
 * shopkeeper in seconds, while standing in the shop. Creates a login for the
 * owner (email + a temporary password the admin sets) so the shopkeeper can
 * immediately sign in and manage their shop. The owner is prompted to change
 * the password on first login. Shop goes live immediately (auto-approved).
 */
router.post('/shops/quick-create', async (req, res, next) => {
  try {
    const data = validateBody(req, quickShopSchema);

    // Create (or reuse) the shop-owner login account.
    const { user: owner, reused } = await createShopOwnerAccount({
      email: data.ownerEmail,
      password: data.ownerPassword,
      name: data.name,
      phone: data.phone,
    });

    const shop = await Shop.create({
      name: data.name,
      owner: owner._id,
      ownerEmail: owner.email,
      category: data.category,
      phone: data.phone,
      description: data.description || '',
      logo: data.logo || undefined,
      address: data.address || {},
      location: { type: 'Point', coordinates: [data.lng, data.lat] },
      slug: adminMakeSlug(data.name),
      isApproved: true, // agent-created → live immediately
      isOpen: true,
    });

    res.status(201).json({
      shop,
      ownerId: owner._id,
      ownerEmail: owner.email,
      reusedExistingAccount: reused,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/shops/:id/approve — flip isApproved=true.
 * Idempotent.
 */
router.post('/shops/:id/approve', async (req, res, next) => {
  try {
    const shop = await Shop.findByIdAndUpdate(
      req.params.id,
      { $set: { isApproved: true, isBlocked: false } },
      { new: true }
    );
    if (!shop) throw new HttpError(404, 'Shop not found');
    res.json({ shop });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/shops/:id/reject — keep isApproved=false, optionally block.
 *
 * Body: { block?: boolean, note?: string }
 * - block=true → also sets isBlocked=true (hard-hides the shop)
 * - note      → recorded on the shop for audit (Phase 6a doesn't surface this
 *               in the UI, but it lands in the doc for later)
 */
const rejectSchema = z.object({
  block: z.boolean().optional(),
  note: z.string().max(500).optional(),
});

router.post('/shops/:id/reject', async (req, res, next) => {
  try {
    const { block, note } = validateBody(req, rejectSchema);
    const update = { isApproved: false };
    if (block) update.isBlocked = true;
    if (note) update.adminNote = note;
    const shop = await Shop.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
    if (!shop) throw new HttpError(404, 'Shop not found');
    res.json({ shop });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/shops/:id/block — toggle isBlocked.
 * Body: { blocked: boolean }
 */
const blockSchema = z.object({ blocked: z.boolean() });

router.post('/shops/:id/block', async (req, res, next) => {
  try {
    const { blocked } = validateBody(req, blockSchema);
    const shop = await Shop.findByIdAndUpdate(
      req.params.id,
      { $set: { isBlocked: blocked } },
      { new: true }
    );
    if (!shop) throw new HttpError(404, 'Shop not found');
    res.json({ shop });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// USERS
// ============================================================

/**
 * GET /api/admin/users?role=&q=&blocked=
 *
 * Lists users with optional filters:
 *   role=customer|shop|delivery|admin
 *   blocked=true|false
 *   q=  — substring match on name or email (case-insensitive)
 */
router.get('/users', async (req, res, next) => {
  try {
    const { role, q, blocked, limit = '100' } = req.query;
    const filter = {};
    if (role) filter.roles = role;
    if (blocked === 'true') filter.isBlocked = true;
    if (blocked === 'false') filter.isBlocked = false;
    if (q) {
      const pattern = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: pattern }, { email: pattern }, { phone: pattern }];
    }
    const users = await User.find(filter)
      .select('-passwordHash')
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 100, 500))
      .lean();
    res.json({ users });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/users/:id/block — toggle isBlocked on a user.
 * Body: { blocked: boolean }
 *
 * Admin cannot block themselves — guard against self-lockout.
 */
router.post('/users/:id/block', async (req, res, next) => {
  try {
    const { blocked } = validateBody(req, blockSchema);
    if (req.params.id === req.user._id.toString()) {
      throw new HttpError(400, 'You cannot block your own account');
    }
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { isBlocked: blocked } },
      { new: true }
    ).select('-passwordHash');
    if (!user) throw new HttpError(404, 'User not found');
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// ORDERS
// ============================================================

/**
 * GET /api/admin/orders?status=&shopId=
 *
 * Cross-shop order view. status accepts a single status, 'active' (anything
 * in flight), or 'all'.
 */
router.get('/orders', async (req, res, next) => {
  try {
    const { status = 'active', shopId, limit = '100' } = req.query;
    const filter = {};
    if (status === 'active') {
      filter.status = {
        $nin: ['delivered', 'cancelled', 'refunded', 'pending_payment'],
      };
    } else if (status !== 'all') {
      filter.status = String(status);
    }
    if (shopId) filter.shop = shopId;

    const orders = await Order.find(filter)
      .populate('shop', 'name logo phone address')
      .populate('customer', 'name email phone')
      .populate('deliveryPartner', 'name email phone')
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 100, 500))
      .lean();

    res.json({ orders });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/bookings?status=&providerId=
 *
 * Cross-provider view of ALL service bookings (plumber, salon, AC repair, …).
 * Mirrors /admin/orders but for the Booking collection. status accepts a
 * single status, 'active' (anything still in flight), or 'all'.
 *
 * Bookings are persisted permanently, so this doubles as the service order
 * history — completed/cancelled bookings remain queryable via status=all.
 */
router.get('/bookings', async (req, res, next) => {
  try {
    const { status = 'active', providerId, limit = '100' } = req.query;
    const filter = {};
    if (status === 'active') {
      filter.status = { $nin: ['completed', 'declined', 'cancelled'] };
    } else if (status !== 'all') {
      filter.status = String(status);
    }
    if (providerId) filter.provider = providerId;

    const bookings = await Booking.find(filter)
      .populate('provider', 'name logo phone address')
      .populate('customer', 'name email phone')
      .populate('serviceCategory', 'name icon')
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 100, 500))
      .lean();

    res.json({ bookings });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/categories — all categories (including inactive).
 * The public /shops/categories endpoint filters by isActive — this doesn't.
 */
// ============================================================
// CATEGORIES
// ============================================================

router.get('/categories', async (_req, res, next) => {
  try {
    const categories = await Category.find({})
      .populate('parent', 'name')
      .sort({ sortOrder: 1, name: 1 })
      .lean();
    res.json({ categories });
  } catch (err) {
    next(err);
  }
});

const categorySchema = z.object({
  name: z.string().trim().min(1).max(60),
  icon: z.string().max(40).optional().or(z.literal('')),
  image: z.string().url().optional().or(z.literal('')),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
  // 8b: optional parent — null/omitted means top-level group.
  // ObjectId shape validated here; existence + non-circular checked in handler.
  parent: z.string().regex(/^[a-f0-9]{24}$/i).nullable().optional(),
});

/** Ensure the chosen parent exists and is itself top-level (one-level limit). */
async function assertValidParent(parentId, selfId = null) {
  if (parentId == null) return; // null/omitted is fine
  if (selfId && parentId === String(selfId)) {
    throw new HttpError(400, 'A category cannot be its own parent');
  }
  const p = await Category.findById(parentId).select('parent').lean();
  if (!p) throw new HttpError(400, 'Parent category does not exist');
  if (p.parent) {
    throw new HttpError(400, 'Parent must itself be a top-level category (only one level of nesting allowed)');
  }
}

router.post('/categories', async (req, res, next) => {
  try {
    const data = validateBody(req, categorySchema);
    const existing = await Category.findOne({ name: data.name });
    if (existing) throw new HttpError(409, 'A category with that name already exists');
    await assertValidParent(data.parent);
    const category = await Category.create({
      name: data.name,
      icon: data.icon || undefined,
      image: data.image || undefined,
      sortOrder: data.sortOrder ?? 0,
      isActive: data.isActive ?? true,
      parent: data.parent || null,
    });
    res.status(201).json({ category });
  } catch (err) {
    next(err);
  }
});

router.patch('/categories/:id', async (req, res, next) => {
  try {
    const data = validateBody(req, categorySchema.partial());
    const update = {};
    if (data.name !== undefined) update.name = data.name;
    if (data.icon !== undefined) update.icon = data.icon || undefined;
    if (data.image !== undefined) update.image = data.image || undefined;
    if (data.sortOrder !== undefined) update.sortOrder = data.sortOrder;
    if (data.isActive !== undefined) update.isActive = data.isActive;
    if (data.parent !== undefined) {
      await assertValidParent(data.parent, req.params.id);
      update.parent = data.parent || null;
    }
    const category = await Category.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
    if (!category) throw new HttpError(404, 'Category not found');
    res.json({ category });
  } catch (err) {
    next(err);
  }
});

router.delete('/categories/:id', async (req, res, next) => {
  try {
    // Soft delete: flag inactive. Hard delete would orphan products/shops
    // that reference this category.
    const category = await Category.findByIdAndUpdate(
      req.params.id,
      { $set: { isActive: false } },
      { new: true }
    );
    if (!category) throw new HttpError(404, 'Category not found');
    res.json({ ok: true, category });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// PHASE 7a — Pricing config
// ============================================================

/** Public read shape — frontend reads to populate the editor. */
router.get('/pricing', async (_req, res, next) => {
  try {
    const cfg = await PricingConfig.getCurrent();
    res.json({ config: cfg });
  } catch (err) {
    next(err);
  }
});

const vehicleUpdateSchema = z.object({
  maxKg: z.number().positive().max(100_000),
  perKmRate: z.number().nonnegative().max(10_000),
  minFee: z.number().nonnegative().max(100_000),
});

const pricingUpdateSchema = z.object({
  vehicles: z.record(z.string(), vehicleUpdateSchema).optional(),
  handlingFee: z.number().nonnegative().max(10_000).optional(),
  platformFeePercent: z.number().min(0).max(50).optional(),
});

/**
 * PATCH /api/admin/pricing — partial update.
 *
 * Body may contain any subset of:
 *   - vehicles: { [vehicleId]: { maxKg, perKmRate, minFee } }
 *   - handlingFee: number
 *   - platformFeePercent: number
 *
 * Vehicle ids must already exist in the config (we don't allow adding new
 * vehicles via this endpoint — keeps the set in sync with the frontend enum).
 */
router.patch('/pricing', async (req, res, next) => {
  try {
    const data = validateBody(req, pricingUpdateSchema);
    const cfg = await PricingConfig.getCurrent();

    if (data.vehicles) {
      for (const [vehicleId, fields] of Object.entries(data.vehicles)) {
        if (!cfg.vehicles?.[vehicleId]) {
          throw new HttpError(400, `Unknown vehicle "${vehicleId}"`);
        }
        cfg.vehicles[vehicleId].maxKg = fields.maxKg;
        cfg.vehicles[vehicleId].perKmRate = fields.perKmRate;
        cfg.vehicles[vehicleId].minFee = fields.minFee;
      }
      // Mongoose can't always tell nested mixed paths changed; mark explicitly.
      cfg.markModified('vehicles');
    }
    if (typeof data.handlingFee === 'number') cfg.handlingFee = data.handlingFee;
    if (typeof data.platformFeePercent === 'number') cfg.platformFeePercent = data.platformFeePercent;

    await cfg.save();
    res.json({ config: cfg });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// App config — platform feature flags (admin Settings tab)
// ============================================================

/** GET /api/admin/config — current flags. */
router.get('/config', async (_req, res, next) => {
  try {
    const cfg = await AppConfig.getCurrent();
    res.json({ flags: cfg.flags });
  } catch (err) {
    next(err);
  }
});

const appConfigUpdateSchema = z.object({
  flags: z.object({
    showAllProducts: z.boolean().optional(),
    enablePhoneLogin: z.boolean().optional(),
    enableVoiceAssistant: z.boolean().optional(),
  }),
});

/**
 * PATCH /api/admin/config — partial flag update.
 * Body: { flags: { showAllProducts?: boolean } }
 */
router.patch('/config', async (req, res, next) => {
  try {
    const data = validateBody(req, appConfigUpdateSchema);
    const cfg = await AppConfig.getCurrent();

    if (typeof data.flags.showAllProducts === 'boolean') {
      cfg.flags.showAllProducts = data.flags.showAllProducts;
    }
    if (typeof data.flags.enablePhoneLogin === 'boolean') {
      cfg.flags.enablePhoneLogin = data.flags.enablePhoneLogin;
    }
    if (typeof data.flags.enableVoiceAssistant === 'boolean') {
      cfg.flags.enableVoiceAssistant = data.flags.enableVoiceAssistant;
    }

    await cfg.save();
    res.json({ flags: cfg.flags });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// PHASE 7a — Withdrawal processing
// ============================================================

router.get('/withdrawals', async (req, res, next) => {
  try {
    const { status = 'all' } = req.query;
    const filter = {};
    if (status !== 'all') filter.status = String(status);
    const requests = await WithdrawRequest.find(filter)
      .populate('deliveryPartner', 'name email phone')
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    res.json({ requests });
  } catch (err) {
    next(err);
  }
});

const withdrawProcessSchema = z.object({
  action: z.enum(['approve', 'paid', 'reject']),
  transactionRef: z.string().trim().max(120).optional(),
  rejectionReason: z.string().trim().max(500).optional(),
});

/**
 * PATCH /api/admin/withdrawals/:id — move a request along its lifecycle.
 *
 * action lifecycle:
 *   pending → approve  (intent to pay, no money moved yet)
 *   approved → paid    (transactionRef required; partner wallet was already
 *                       debited at submit-time, so nothing to debit again here)
 *   pending → reject   (rejectionReason required; refund the wallet)
 */
router.patch('/withdrawals/:id', async (req, res, next) => {
  try {
    const data = validateBody(req, withdrawProcessSchema);
    const wr = await WithdrawRequest.findById(req.params.id);
    if (!wr) throw new HttpError(404, 'Withdrawal request not found');

    if (data.action === 'approve') {
      if (wr.status !== 'pending') throw new HttpError(409, `Cannot approve from "${wr.status}"`);
      wr.status = 'approved';
    } else if (data.action === 'paid') {
      if (wr.status !== 'approved') throw new HttpError(409, `Cannot mark paid from "${wr.status}"`);
      if (!data.transactionRef) throw new HttpError(400, 'transactionRef is required');
      wr.status = 'paid';
      wr.transactionRef = data.transactionRef;
    } else if (data.action === 'reject') {
      if (!['pending', 'approved'].includes(wr.status)) {
        throw new HttpError(409, `Cannot reject from "${wr.status}"`);
      }
      if (!data.rejectionReason) throw new HttpError(400, 'rejectionReason is required');
      wr.status = 'rejected';
      wr.rejectionReason = data.rejectionReason;
      // Refund the partner's wallet — we debited at submit-time.
      await DeliveryProfile.updateOne(
        { user: wr.deliveryPartner },
        { $inc: { walletBalance: wr.amount } }
      );
    }
    wr.processedBy = req.user._id;
    wr.processedAt = new Date();
    await wr.save();

    res.json({ request: wr });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// PHASE 7c — Shop discounts
// ============================================================

const shopDiscountSchema = z.object({
  enabled: z.boolean(),
  type: z.enum(['percent', 'flat']),
  value: z.number().nonnegative().max(100_000),
  label: z.string().trim().max(80).default(''),
});

/**
 * PATCH /api/admin/shops/:id/discount — set/clear a shop's discount.
 *
 * The discount lives on the Shop document; pricing.js applies it
 * automatically at quote time. If `enabled: false` we still persist the
 * other fields so the previous config is preserved when re-enabled.
 *
 * Percent values are validated 0-100 because larger percent discounts make
 * no sense; flat values are validated against the 100k cap (already done
 * by the schema).
 */
router.patch('/shops/:id/discount', async (req, res, next) => {
  try {
    const data = validateBody(req, shopDiscountSchema);
    if (data.type === 'percent' && data.value > 100) {
      throw new HttpError(400, 'Percent discount cannot exceed 100');
    }
    const shop = await Shop.findByIdAndUpdate(
      req.params.id,
      { $set: { discount: data } },
      { new: true }
    );
    if (!shop) throw new HttpError(404, 'Shop not found');
    res.json({ shop });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// PHASE 7c — Admin product oversight
// ============================================================

/**
 * GET /api/admin/products?q=&shopId=&page=&limit=
 *
 * Cross-shop product search for moderation. Supports text search on name
 * and category, optional shopId filter, basic pagination.
 *
 * Default sort: newest first. `inactive` query=true also surfaces soft-
 * deleted products so admins can review takedowns.
 */
router.get('/products', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const shopId = String(req.query.shopId || '').trim();
    const includeInactive = req.query.inactive === 'true';
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));

    const filter = {};
    if (!includeInactive) filter.isActive = { $ne: false };
    if (shopId) filter.shop = shopId;
    if (q) {
      filter.$or = [
        { name: { $regex: q, $options: 'i' } },
        { category: { $regex: q, $options: 'i' } },
      ];
    }

    const [products, total] = await Promise.all([
      Product.find(filter)
        .populate('shop', 'name')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Product.countDocuments(filter),
    ]);

    res.json({ products, total, page, limit });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/admin/products/:id — toggle visibility (soft delete).
 *
 * We don't hard-delete because orders may reference the product. Toggling
 * isActive=false hides it from customer browse and any new add-to-cart, but
 * existing orders retain their snapshot data.
 */
router.patch('/products/:id', async (req, res, next) => {
  try {
    const data = validateBody(req, z.object({ isActive: z.boolean() }));
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { $set: { isActive: data.isActive } },
      { new: true }
    );
    if (!product) throw new HttpError(404, 'Product not found');
    res.json({ product });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// PHASE 7c — Delivery partner doc verification
// ============================================================

/**
 * GET /api/admin/delivery-partners?verified=
 *
 * List delivery partners with their submitted documents for review.
 * `verified` filter: 'true' / 'false' / 'pending' (any partner with at least
 * one document URL but verified=false).
 */
router.get('/delivery-partners', async (req, res, next) => {
  try {
    const v = String(req.query.verified || '');

    const filter = {};
    if (v === 'true') filter['documents.verified'] = true;
    else if (v === 'false') filter['documents.verified'] = { $ne: true };
    else if (v === 'pending') {
      filter['documents.verified'] = { $ne: true };
      filter.$or = [
        { 'documents.drivingLicenseUrl': { $exists: true, $ne: '' } },
        { 'documents.aadhaarUrl': { $exists: true, $ne: '' } },
        { 'documents.vehicleRcUrl': { $exists: true, $ne: '' } },
      ];
    }

    const partners = await DeliveryProfile.find(filter)
      .populate('user', 'name email phone')
      .sort({ updatedAt: -1 })
      .limit(100)
      .lean();
    res.json({ partners });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/admin/delivery-partners/:userId/verify
 *
 * Flip documents.verified. We don't keep history beyond the timestamp; if
 * we ever need a revocation audit, add a verifiedAt + verifiedBy field.
 */
router.patch('/delivery-partners/:userId/verify', async (req, res, next) => {
  try {
    const data = validateBody(req, z.object({ verified: z.boolean() }));
    const profile = await DeliveryProfile.findOneAndUpdate(
      { user: req.params.userId },
      { $set: { 'documents.verified': data.verified } },
      { new: true }
    ).populate('user', 'name email phone');
    if (!profile) throw new HttpError(404, 'Delivery partner not found');
    res.json({ profile });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// PHASE 8d — Product templates (catalog library)
// ============================================================

const templateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  weight: z.string().trim().max(40).optional().or(z.literal('')),
  suggestedPrice: z.number().nonnegative().max(1_000_000),
  group: z.string().trim().min(1).max(40),
  category: z.string().regex(/^[a-f0-9]{24}$/i).nullable().optional(),
  image: z.string().url().optional().or(z.literal('')),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

router.get('/templates', async (_req, res, next) => {
  try {
    const templates = await ProductTemplate.find({})
      .populate('category', 'name')
      .sort({ group: 1, sortOrder: 1, name: 1 })
      .lean();
    res.json({ templates });
  } catch (err) {
    next(err);
  }
});

router.post('/templates', async (req, res, next) => {
  try {
    const data = validateBody(req, templateSchema);
    const tpl = await ProductTemplate.create({
      name: data.name,
      weight: data.weight || '',
      suggestedPrice: data.suggestedPrice,
      group: data.group,
      category: data.category || null,
      image: data.image || '',
      sortOrder: data.sortOrder ?? 0,
      isActive: data.isActive ?? true,
    });
    res.status(201).json({ template: tpl });
  } catch (err) {
    next(err);
  }
});

router.patch('/templates/:id', async (req, res, next) => {
  try {
    const data = validateBody(req, templateSchema.partial());
    const update = {};
    for (const key of ['name', 'weight', 'suggestedPrice', 'group', 'image', 'sortOrder', 'isActive']) {
      if (data[key] !== undefined) update[key] = data[key];
    }
    if (data.category !== undefined) update.category = data.category || null;

    const tpl = await ProductTemplate.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true }
    );
    if (!tpl) throw new HttpError(404, 'Template not found');
    res.json({ template: tpl });
  } catch (err) {
    next(err);
  }
});

router.delete('/templates/:id', async (req, res, next) => {
  try {
    const tpl = await ProductTemplate.findByIdAndDelete(req.params.id);
    if (!tpl) throw new HttpError(404, 'Template not found');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
