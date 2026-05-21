import { Router } from 'express';
import { z } from 'zod';

import { TransportOrder, PricingConfig, DeliveryProfile } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/role.js';
import { validateBody } from '../utils/validate.js';
import { HttpError } from '../middleware/error.js';
import { distanceKm, deliveryFee } from '../services/pricing.js';

const router = Router();

/* ============================================================
 * PHASE 6b.1 — Customer transport booking
 * PHASE 6b.2 — Delivery partner transport jobs (this turn)
 *
 * Lifecycle:
 *   pending_payment → placed (customer)
 *   placed          → accepted   (partner grabs)
 *   accepted        → picked_up  (partner collected cargo)
 *   picked_up       → in_transit (partner leaving pickup)
 *   in_transit      → delivered  (handed off + wallet credit)
 *
 * Partners only see transport jobs whose vehicleId matches their
 * DeliveryProfile.vehicleType — a bike partner doesn't see Tata 407 jobs.
 * ============================================================ */

const VEHICLE_IDS = ['bike', '3wheeler', 'tataAce', 'pickup8ft', 'tata407'];

// Partner-side state machine.
const PARTNER_TRANSITIONS = {
  accepted: ['picked_up'],
  picked_up: ['in_transit'],
  in_transit: ['delivered'],
};

const latLngSchema = z.object({
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
});

const partySchema = z.object({
  name: z.string().trim().min(1).max(80),
  phone: z.string().trim().min(10).max(20),
  address: z.string().trim().min(1).max(300),
});

// ----- helpers -----

async function priceQuote({ vehicleId, pickup, drop }) {
  const cfg = await PricingConfig.getCurrent();
  const vehicle = cfg.vehicles?.[vehicleId];
  if (!vehicle) throw new HttpError(400, `Unknown vehicle "${vehicleId}"`);

  const km = Number(
    distanceKm([pickup.lng, pickup.lat], [drop.lng, drop.lat]).toFixed(2)
  );
  const fee = deliveryFee(vehicle, km);
  const platformFee = Math.round((fee * (cfg.platformFeePercent || 0)) / 100);
  const total = fee + platformFee;

  return {
    vehicleId,
    vehicleName: vehicle.name,
    icon: vehicle.icon,
    distanceKm: km,
    fee,
    platformFee,
    total,
    minFee: vehicle.minFee,
    perKmRate: vehicle.perKmRate,
    maxKg: vehicle.maxKg,
  };
}

function emitStatusUpdate(req, order) {
  const io = req.app.get('io');
  if (!io) return;
  io.to(`order:${order._id}`).emit('order:status_update', {
    orderId: order._id.toString(),
    status: order.status,
    deliveryPartner: order.deliveryPartner?.toString() || null,
    at: Date.now(),
    kind: 'transport',
  });
}

async function getOrCreateProfile(userId) {
  let profile = await DeliveryProfile.findOne({ user: userId });
  if (!profile) profile = await DeliveryProfile.create({ user: userId });
  return profile;
}

// ============================================================
// CUSTOMER — quotes
// ============================================================

const quoteSchema = z.object({
  vehicleId: z.enum(VEHICLE_IDS),
  pickup: latLngSchema,
  drop: latLngSchema,
});

router.post('/quote', requireAuth, async (req, res, next) => {
  try {
    const data = validateBody(req, quoteSchema);
    const quote = await priceQuote(data);
    res.json({ quote });
  } catch (err) {
    next(err);
  }
});

router.post('/quote-all', requireAuth, async (req, res, next) => {
  try {
    const data = validateBody(req, z.object({ pickup: latLngSchema, drop: latLngSchema }));
    const cfg = await PricingConfig.getCurrent();
    const quotes = [];
    for (const vehicleId of VEHICLE_IDS) {
      if (!cfg.vehicles?.[vehicleId]) continue;
      try {
        quotes.push(await priceQuote({ vehicleId, pickup: data.pickup, drop: data.drop }));
      } catch {
        /* skip */
      }
    }
    quotes.sort((a, b) => a.total - b.total);
    res.json({ quotes });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// CUSTOMER — book / list / get / cancel
// ============================================================

const bookSchema = z.object({
  vehicleId: z.enum(VEHICLE_IDS),
  pickup: partySchema.extend({ location: latLngSchema }),
  drop: partySchema.extend({ location: latLngSchema }),
  estimatedWeightKg: z.number().min(0).max(10_000).optional(),
  notes: z.string().max(500).optional(),
  paymentMethod: z.enum(['cod', 'razorpay']).default('cod'),
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const data = validateBody(req, bookSchema);
    const quote = await priceQuote({
      vehicleId: data.vehicleId,
      pickup: data.pickup.location,
      drop: data.drop.location,
    });
    const isCod = data.paymentMethod === 'cod';

    const order = await TransportOrder.create({
      customer: req.user._id,
      vehicleId: data.vehicleId,
      pickup: {
        name: data.pickup.name,
        phone: data.pickup.phone,
        address: data.pickup.address,
        location: { type: 'Point', coordinates: [data.pickup.location.lng, data.pickup.location.lat] },
      },
      drop: {
        name: data.drop.name,
        phone: data.drop.phone,
        address: data.drop.address,
        location: { type: 'Point', coordinates: [data.drop.location.lng, data.drop.location.lat] },
      },
      distanceKm: quote.distanceKm,
      estimatedWeightKg: data.estimatedWeightKg,
      notes: data.notes,
      fee: quote.fee,
      platformFee: quote.platformFee,
      total: quote.total,
      status: isCod ? 'placed' : 'pending_payment',
      statusHistory: [
        { status: isCod ? 'placed' : 'pending_payment', by: req.user._id, note: 'Created by customer' },
      ],
      payment: { method: data.paymentMethod, status: 'pending' },
      placedAt: isCod ? new Date() : undefined,
    });

    res.status(201).json({ order });
  } catch (err) {
    next(err);
  }
});

router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const { status = 'active' } = req.query;
    const filter = { customer: req.user._id };
    if (status === 'active') {
      filter.status = { $nin: ['delivered', 'cancelled', 'refunded'] };
    } else if (status !== 'all') {
      filter.status = String(status);
    }
    const orders = await TransportOrder.find(filter)
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json({ orders });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// DELIVERY PARTNER — job feed
// (Specific routes BEFORE the `/:id` catch-all, otherwise 'jobs' / 'my-jobs'
// would be interpreted as IDs.)
// ============================================================

/**
 * GET /api/transport/jobs?lng=&lat=&radiusKm=
 *
 * Available transport bookings near the partner, filtered by their vehicleType.
 * If the partner hasn't set a vehicleType yet, returns 400 (with a clear
 * message) — the dashboard renders a "set your vehicle" prompt off this.
 *
 * Uses the 2dsphere on pickup.location to query.
 */
router.get('/jobs', requireAuth, requireRole('delivery'), async (req, res, next) => {
  try {
    let { lng, lat, radiusKm = '5' } = req.query;

    const profile = await getOrCreateProfile(req.user._id);
    if (!profile.vehicleType) {
      throw new HttpError(400, 'Set your vehicle type to see transport jobs');
    }

    if (lng == null || lat == null) {
      const coords = profile.currentLocation?.coordinates;
      if (!coords || coords.length !== 2) {
        throw new HttpError(400, 'Location required — enable GPS or pass lng/lat');
      }
      [lng, lat] = coords;
    }
    lng = Number(lng);
    lat = Number(lat);
    const radius = Math.min(Math.max(Number(radiusKm) || 5, 1), 25);

    const orders = await TransportOrder.find({
      vehicleId: profile.vehicleType,
      status: 'placed',
      deliveryPartner: { $in: [null, undefined] },
      'pickup.location': {
        $nearSphere: {
          $geometry: { type: 'Point', coordinates: [lng, lat] },
          $maxDistance: radius * 1000,
        },
      },
    })
      .sort({ createdAt: 1 })
      .limit(50)
      .lean();

    // Attach distance-to-pickup (computed locally; the geo query has already
    // narrowed the set so this is over ≤50 docs).
    const jobs = orders.map((o) => {
      const pc = o.pickup?.location?.coordinates;
      const distToPickup = pc ? distanceKm([lng, lat], pc) : null;
      return {
        ...o,
        distanceToPickupKm: distToPickup != null ? Math.round(distToPickup * 10) / 10 : null,
      };
    });

    res.json({ jobs });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/transport/my-jobs — partner's currently-assigned active transport.
 */
router.get('/my-jobs', requireAuth, requireRole('delivery'), async (req, res, next) => {
  try {
    const orders = await TransportOrder.find({
      deliveryPartner: req.user._id,
      status: { $in: ['accepted', 'picked_up', 'in_transit'] },
    })
      .sort({ updatedAt: -1 })
      .lean();
    res.json({ jobs: orders });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// CUSTOMER — single booking + cancel
// (These come AFTER /jobs and /my-jobs above for routing precedence.)
// ============================================================

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const order = await TransportOrder.findById(req.params.id)
      .populate('deliveryPartner', 'name phone')
      .lean();
    if (!order) return res.status(404).json({ error: 'Booking not found' });

    const callerId = req.user._id.toString();
    const isCustomer = order.customer.toString() === callerId;
    const isPartner = order.deliveryPartner?._id?.toString() === callerId;
    const isAdmin = req.user.roles?.includes('admin');
    if (!isCustomer && !isPartner && !isAdmin) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    res.json({ order });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const order = await TransportOrder.findById(req.params.id);
    if (!order) throw new HttpError(404, 'Booking not found');
    if (order.customer.toString() !== req.user._id.toString()) {
      throw new HttpError(403, 'Not your booking');
    }
    if (!['placed', 'pending_payment'].includes(order.status)) {
      throw new HttpError(409, 'This booking can no longer be cancelled');
    }
    order.status = 'cancelled';
    order.statusHistory.push({ status: 'cancelled', by: req.user._id, note: 'Cancelled by customer' });
    await order.save();
    emitStatusUpdate(req, order);
    res.json({ order });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// DELIVERY PARTNER — grab + lifecycle
// ============================================================

/**
 * POST /api/transport/:id/accept — partner grabs a transport job.
 * Same first-wins guard as grocery accept: atomic update whose filter
 * requires deliveryPartner to still be null. Also enforces vehicleType match
 * server-side (a bike partner can't accept a Tata 407 job by tampering with
 * the client).
 */
router.post('/:id/accept', requireAuth, requireRole('delivery'), async (req, res, next) => {
  try {
    const profile = await getOrCreateProfile(req.user._id);
    if (!profile.available) {
      throw new HttpError(409, 'Go online before accepting jobs');
    }
    if (!profile.vehicleType) {
      throw new HttpError(409, 'Set your vehicle type first');
    }

    const result = await TransportOrder.findOneAndUpdate(
      {
        _id: req.params.id,
        status: 'placed',
        vehicleId: profile.vehicleType,
        deliveryPartner: { $in: [null, undefined] },
      },
      {
        $set: { deliveryPartner: req.user._id, status: 'accepted' },
        $push: {
          statusHistory: { status: 'accepted', by: req.user._id, note: 'Accepted by delivery partner' },
        },
      },
      { new: true }
    );

    if (!result) {
      const exists = await TransportOrder.exists({ _id: req.params.id });
      throw new HttpError(
        exists ? 409 : 404,
        exists ? 'This job was already taken or doesn\'t match your vehicle' : 'Booking not found'
      );
    }

    emitStatusUpdate(req, result);
    const io = req.app.get('io');
    io?.to('delivery:available').emit('job:taken', {
      orderId: result._id.toString(),
      kind: 'transport',
    });

    res.json({ order: result });
  } catch (err) {
    next(err);
  }
});

/**
 * Shared partner transition handler.
 */
async function partnerTransition(req, res, next, targetStatus, note) {
  try {
    const order = await TransportOrder.findById(req.params.id);
    if (!order) throw new HttpError(404, 'Booking not found');
    if (order.deliveryPartner?.toString() !== req.user._id.toString()) {
      throw new HttpError(403, 'This job is not assigned to you');
    }
    const allowed = PARTNER_TRANSITIONS[order.status] || [];
    if (!allowed.includes(targetStatus)) {
      throw new HttpError(
        409,
        `Cannot move a job from "${order.status}" to "${targetStatus}"`
      );
    }
    order.status = targetStatus;
    order.statusHistory.push({ status: targetStatus, by: req.user._id, note });
    if (targetStatus === 'delivered') order.deliveredAt = new Date();
    await order.save();

    // Wallet credit on delivery — same pattern as grocery.
    if (targetStatus === 'delivered') {
      await DeliveryProfile.updateOne(
        { user: req.user._id },
        {
          $inc: {
            walletBalance: order.fee || 0,
            totalEarnings: order.fee || 0,
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

router.post('/:id/pickup', requireAuth, requireRole('delivery'), (req, res, next) =>
  partnerTransition(req, res, next, 'picked_up', 'Cargo collected from pickup')
);
router.post('/:id/start', requireAuth, requireRole('delivery'), (req, res, next) =>
  partnerTransition(req, res, next, 'in_transit', 'In transit to drop-off')
);
router.post('/:id/deliver', requireAuth, requireRole('delivery'), (req, res, next) =>
  partnerTransition(req, res, next, 'delivered', 'Delivered to recipient')
);

export default router;
