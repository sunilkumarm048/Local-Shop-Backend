import { Router } from 'express';
import { z } from 'zod';

import { TransportOrder, PricingConfig } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { validateBody } from '../utils/validate.js';
import { HttpError } from '../middleware/error.js';
import { distanceKm, deliveryFee } from '../services/pricing.js';

const router = Router();

/* ============================================================
 * PHASE 6b.1 — Transport booking (customer-side backend)
 *
 * A transport order is a pure logistics booking — no shop, no products.
 * Customer picks pickup + drop + vehicle, sees a fare quote, and books.
 * The booking sits at `status: placed` until 6b.2 wires the delivery
 * partner side to accept it.
 *
 * Pricing reuses the same vehicle table the grocery delivery flow uses
 * (PricingConfig.vehicles[id].perKmRate / minFee).
 * ============================================================ */

const VEHICLE_IDS = ['bike', '3wheeler', 'tataAce', 'pickup8ft', 'tata407'];

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

/**
 * Compute fare for a transport leg. Same vehicle table as grocery delivery.
 */
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

/**
 * Emit a status update for a transport order — same pattern as the grocery
 * order one (shop room not relevant here; just the order room for tracking).
 */
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

// ============================================================
// PUBLIC-ish (auth required) endpoints
// ============================================================

/**
 * POST /api/transport/quote — fare estimate for a single vehicle choice.
 *   Body: { vehicleId, pickup: {lng,lat}, drop: {lng,lat} }
 */
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

/**
 * POST /api/transport/quote-all — fare for every vehicle, sorted by total.
 *   Body: { pickup, drop }
 * Used by the customer booking page to render the "pick a vehicle" grid.
 */
router.post('/quote-all', requireAuth, async (req, res, next) => {
  try {
    const data = validateBody(req, z.object({ pickup: latLngSchema, drop: latLngSchema }));
    const cfg = await PricingConfig.getCurrent();

    const quotes = [];
    for (const vehicleId of VEHICLE_IDS) {
      if (!cfg.vehicles?.[vehicleId]) continue;
      // priceQuote may throw if a vehicle was deleted from config; skip those.
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

/**
 * POST /api/transport — book a transport order.
 *
 * Body: {
 *   vehicleId,
 *   pickup: { name, phone, address, location: {lng,lat} },
 *   drop:   { name, phone, address, location: {lng,lat} },
 *   estimatedWeightKg?, notes?, paymentMethod ('cod' | 'razorpay')
 * }
 *
 * For COD we mark status='placed' immediately. Razorpay flow follows the same
 * pattern as grocery checkout (placed=pending_payment until the webhook flips
 * it to placed) — implemented when real Razorpay keys land.
 */
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

    // Re-price server-side — don't trust whatever the client sent.
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
        location: {
          type: 'Point',
          coordinates: [data.pickup.location.lng, data.pickup.location.lat],
        },
      },
      drop: {
        name: data.drop.name,
        phone: data.drop.phone,
        address: data.drop.address,
        location: {
          type: 'Point',
          coordinates: [data.drop.location.lng, data.drop.location.lat],
        },
      },
      distanceKm: quote.distanceKm,
      estimatedWeightKg: data.estimatedWeightKg,
      notes: data.notes,
      fee: quote.fee,
      platformFee: quote.platformFee,
      total: quote.total,
      status: isCod ? 'placed' : 'pending_payment',
      statusHistory: [
        {
          status: isCod ? 'placed' : 'pending_payment',
          by: req.user._id,
          note: 'Created by customer',
        },
      ],
      payment: {
        method: data.paymentMethod,
        status: isCod ? 'pending' : 'pending', // COD: collected at drop
      },
      placedAt: isCod ? new Date() : undefined,
    });

    res.status(201).json({ order });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/transport/mine — customer's own transport bookings.
 *   ?status=active|all (default active = anything not delivered/cancelled)
 */
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

/**
 * GET /api/transport/:id — single transport order.
 * Visible to the customer who placed it, the assigned delivery partner, and
 * admins. Anyone else gets 404 (don't leak existence).
 */
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

/**
 * POST /api/transport/:id/cancel — customer cancels their own booking.
 * Only allowed if no partner has accepted yet (status placed / pending_payment).
 */
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
    order.statusHistory.push({
      status: 'cancelled',
      by: req.user._id,
      note: 'Cancelled by customer',
    });
    await order.save();
    emitStatusUpdate(req, order);
    res.json({ order });
  } catch (err) {
    next(err);
  }
});

export default router;
