import { Router } from 'express';
import { z } from 'zod';

import { User, Shop, Order, Category, PricingConfig, WithdrawRequest, DeliveryProfile } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/role.js';
import { validateBody } from '../utils/validate.js';
import { HttpError } from '../middleware/error.js';

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
      .populate('shop', 'name logo')
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

// ============================================================
// CATEGORIES
// ============================================================

/**
 * GET /api/admin/categories — all categories (including inactive).
 * The public /shops/categories endpoint filters by isActive — this doesn't.
 */
router.get('/categories', async (_req, res, next) => {
  try {
    const categories = await Category.find({}).sort({ sortOrder: 1, name: 1 }).lean();
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
});

router.post('/categories', async (req, res, next) => {
  try {
    const data = validateBody(req, categorySchema);
    const existing = await Category.findOne({ name: data.name });
    if (existing) throw new HttpError(409, 'A category with that name already exists');
    const category = await Category.create({
      name: data.name,
      icon: data.icon || undefined,
      image: data.image || undefined,
      sortOrder: data.sortOrder ?? 0,
      isActive: data.isActive ?? true,
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

export default router;
