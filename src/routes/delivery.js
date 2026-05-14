import { Router } from 'express';
import { z } from 'zod';

import { Order, Shop, DeliveryProfile } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/role.js';
import { validateBody } from '../utils/validate.js';
import { HttpError } from '../middleware/error.js';
import { distanceKm } from '../services/pricing.js';

const router = Router();

/* ============================================================
 * PHASE 5a — Delivery partner dashboard (backend)
 *
 * A delivery partner:
 *   - has a DeliveryProfile (created at signup for role 'delivery')
 *   - goes online/offline (also togglable over Socket.IO)
 *   - sees a feed of orders in `ready_for_pickup` with no partner yet,
 *     within a radius of their current location
 *   - grabs a job (first-to-accept wins — atomic guard below)
 *   - moves it through: picked_up → out_for_delivery → delivered
 *
 * Auto-assign-if-idle is intentionally NOT here — it depends on the live
 * location plumbing that Phase 5b adds. See PHASE_5A_NOTES.md.
 * ============================================================ */

// Delivery-side lifecycle. Mirrors OWNER_TRANSITIONS in routes/orders.js but
// for the segment a delivery partner owns.
const DELIVERY_TRANSITIONS = {
  ready_for_pickup: ['picked_up'],
  picked_up: ['out_for_delivery'],
  out_for_delivery: ['delivered'],
};

/**
 * Load the caller's DeliveryProfile, creating a bare one if missing.
 * (Signup should create it, but older 'delivery' accounts may predate that.)
 */
async function getOrCreateProfile(userId) {
  let profile = await DeliveryProfile.findOne({ user: userId });
  if (!profile) {
    profile = await DeliveryProfile.create({ user: userId });
  }
  return profile;
}

/**
 * Emit an order status change to the shop room + the order room.
 * Same shape as routes/orders.js emitStatusUpdate so all clients can share
 * one `order:status_update` handler.
 */
function emitStatusUpdate(req, order) {
  const io = req.app.get('io');
  if (!io) return;
  const payload = {
    orderId: order._id.toString(),
    shopId: order.shop.toString(),
    status: order.status,
    deliveryPartner: order.deliveryPartner?.toString() || null,
    at: Date.now(),
  };
  io.to(`shop:${order.shop}`).emit('order:status_update', payload);
  io.to(`order:${order._id}`).emit('order:status_update', payload);
}

// ============================================================
// PROFILE
// ============================================================

/**
 * GET /api/delivery/me — the caller's delivery profile + summary stats.
 */
router.get('/me', requireAuth, requireRole('delivery'), async (req, res, next) => {
  try {
    const profile = await getOrCreateProfile(req.user._id);
    res.json({ profile });
  } catch (err) {
    next(err);
  }
});

const updateProfileSchema = z.object({
  available: z.boolean().optional(),
  vehicleType: z.enum(['bike', '3wheeler', 'tataAce', 'pickup8ft', 'tata407']).optional(),
  vehicleNumber: z.string().max(20).optional(),
  licenseNumber: z.string().max(40).optional(),
});

/**
 * PATCH /api/delivery/me — update vehicle info / online status.
 *
 * The online toggle is ALSO available over Socket.IO (`delivery:online`),
 * which is what the dashboard uses for instant feedback. This HTTP route is
 * the durable fallback + lets the partner set vehicle details.
 */
router.patch('/me', requireAuth, requireRole('delivery'), async (req, res, next) => {
  try {
    const data = validateBody(req, updateProfileSchema);
    const profile = await getOrCreateProfile(req.user._id);

    if (data.available !== undefined) profile.available = data.available;
    if (data.vehicleType !== undefined) profile.vehicleType = data.vehicleType;
    if (data.vehicleNumber !== undefined) profile.vehicleNumber = data.vehicleNumber;
    if (data.licenseNumber !== undefined) profile.licenseNumber = data.licenseNumber;

    await profile.save();
    res.json({ profile });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// JOB FEED
// ============================================================

/**
 * GET /api/delivery/jobs?lng=&lat=&radiusKm=
 *
 * Available pickups: orders in `ready_for_pickup` with no deliveryPartner,
 * whose SHOP is within radiusKm of the partner's location. Sorted nearest-first.
 *
 * Orders don't store the shop's coordinates, so we geo-query shops first
 * (they have a 2dsphere index), then find unclaimed orders for those shops.
 *
 * If lng/lat are omitted we fall back to the partner's last known
 * currentLocation; if that's also missing, we 400 (the dashboard always
 * sends coords once it has a GPS fix).
 */
router.get('/jobs', requireAuth, requireRole('delivery'), async (req, res, next) => {
  try {
    let { lng, lat, radiusKm = '5' } = req.query;

    if (lng == null || lat == null) {
      const profile = await getOrCreateProfile(req.user._id);
      const coords = profile.currentLocation?.coordinates;
      if (!coords || coords.length !== 2) {
        throw new HttpError(400, 'Location required — enable GPS or pass lng/lat');
      }
      [lng, lat] = coords;
    }

    lng = Number(lng);
    lat = Number(lat);
    const radius = Math.min(Math.max(Number(radiusKm) || 5, 1), 25); // clamp 1–25 km

    // 1. Shops within radius
    const shops = await Shop.find({
      location: {
        $nearSphere: {
          $geometry: { type: 'Point', coordinates: [lng, lat] },
          $maxDistance: radius * 1000,
        },
      },
    })
      .select('_id name logo location address')
      .lean();

    if (shops.length === 0) return res.json({ jobs: [] });

    const shopById = new Map(shops.map((s) => [s._id.toString(), s]));

    // 2. Unclaimed ready orders for those shops
    const orders = await Order.find({
      shop: { $in: shops.map((s) => s._id) },
      status: 'ready_for_pickup',
      deliveryPartner: { $in: [null, undefined] },
    })
      .sort({ createdAt: 1 }) // oldest first — fairness
      .limit(50)
      .lean();

    // 3. Attach shop + distance, sort nearest-first
    const jobs = orders
      .map((o) => {
        const shop = shopById.get(o.shop.toString());
        const shopCoords = shop?.location?.coordinates;
        const distToShop = shopCoords ? distanceKm([lng, lat], shopCoords) : null;
        return {
          orderId: o._id.toString(),
          shop: shop
            ? { _id: shop._id, name: shop.name, logo: shop.logo, address: shop.address }
            : null,
          items: o.items,
          total: o.total,
          deliveryFee: o.deliveryFee,
          recipient: o.recipient,
          vehicleId: o.vehicleId,
          distanceKm: o.distanceKm, // shop→customer, saved at checkout
          isSplit: o.isSplit,
          createdAt: o.createdAt,
          distanceToShopKm: distToShop != null ? Math.round(distToShop * 10) / 10 : null,
        };
      })
      .sort((a, b) => (a.distanceToShopKm ?? 999) - (b.distanceToShopKm ?? 999));

    res.json({ jobs });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/delivery/my-jobs — the partner's currently-assigned active orders
 * (picked_up / out_for_delivery, plus ready_for_pickup ones they just grabbed).
 */
router.get('/my-jobs', requireAuth, requireRole('delivery'), async (req, res, next) => {
  try {
    const orders = await Order.find({
      deliveryPartner: req.user._id,
      status: { $in: ['ready_for_pickup', 'picked_up', 'out_for_delivery'] },
    })
      .sort({ updatedAt: -1 })
      .populate('shop', 'name logo location address')
      .lean();
    res.json({ jobs: orders });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// GRAB + LIFECYCLE
// ============================================================

/**
 * POST /api/delivery/jobs/:orderId/accept
 *
 * Grab a job. First-to-accept wins: the updateOne filter requires
 * deliveryPartner to still be null, so a second concurrent grab matches
 * zero docs and we 409. No transaction needed — the filter IS the lock.
 */
router.post(
  '/jobs/:orderId/accept',
  requireAuth,
  requireRole('delivery'),
  async (req, res, next) => {
    try {
      // Partner must be online to grab.
      const profile = await getOrCreateProfile(req.user._id);
      if (!profile.available) {
        throw new HttpError(409, 'Go online before accepting jobs');
      }

      const result = await Order.findOneAndUpdate(
        {
          _id: req.params.orderId,
          status: 'ready_for_pickup',
          deliveryPartner: { $in: [null, undefined] },
        },
        {
          $set: { deliveryPartner: req.user._id },
          $push: {
            statusHistory: {
              status: 'ready_for_pickup',
              by: req.user._id,
              note: 'Picked up by delivery partner (assigned)',
            },
          },
        },
        { new: true }
      );

      if (!result) {
        // Either the order doesn't exist, isn't ready, or someone else grabbed it.
        const exists = await Order.exists({ _id: req.params.orderId });
        throw new HttpError(
          exists ? 409 : 404,
          exists ? 'This job was already taken' : 'Order not found'
        );
      }

      emitStatusUpdate(req, result);
      // Tell other online partners this one's gone so their feeds can drop it.
      const io = req.app.get('io');
      io?.to('delivery:available').emit('job:taken', { orderId: result._id.toString() });

      res.json({ order: result });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Shared handler for the delivery-side transitions.
 */
async function deliveryTransition(req, res, next, targetStatus, note) {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) throw new HttpError(404, 'Order not found');

    if (order.deliveryPartner?.toString() !== req.user._id.toString()) {
      throw new HttpError(403, 'This job is not assigned to you');
    }

    const allowed = DELIVERY_TRANSITIONS[order.status] || [];
    if (!allowed.includes(targetStatus)) {
      throw new HttpError(
        409,
        `Cannot move a job from "${order.status}" to "${targetStatus}"`
      );
    }

    order.status = targetStatus;
    order.statusHistory.push({ status: targetStatus, by: req.user._id, note });
    if (targetStatus === 'delivered') {
      order.deliveredAt = new Date();
    }
    await order.save();

    // On delivery, credit the partner's wallet with the delivery fee and
    // bump their counters. totalEarnings is lifetime; walletBalance is
    // withdrawable (Phase 6 wires withdrawals).
    if (targetStatus === 'delivered') {
      await DeliveryProfile.updateOne(
        { user: req.user._id },
        {
          $inc: {
            walletBalance: order.deliveryFee || 0,
            totalEarnings: order.deliveryFee || 0,
            totalDeliveries: 1,
          },
        }
      );
    }

    emitStatusUpdate(req, order);
    res.json({ order });
  } catch (err) {
    next(err);
  }
}

router.post('/jobs/:orderId/pickup', requireAuth, requireRole('delivery'), (req, res, next) =>
  deliveryTransition(req, res, next, 'picked_up', 'Picked up from shop')
);
router.post('/jobs/:orderId/onway', requireAuth, requireRole('delivery'), (req, res, next) =>
  deliveryTransition(req, res, next, 'out_for_delivery', 'Out for delivery')
);
router.post('/jobs/:orderId/deliver', requireAuth, requireRole('delivery'), (req, res, next) =>
  deliveryTransition(req, res, next, 'delivered', 'Delivered to customer')
);

export default router;
