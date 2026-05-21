import { Order, Shop, TransportOrder, DeliveryProfile } from '../models/index.js';

/**
 * PHASE 5b — Auto-assign idle pickups (grocery orders).
 * PHASE 6b.2 — Auto-assign idle transport bookings.
 *
 * Every TICK_INTERVAL_MS we sweep both queues:
 *   - Grocery: orders in `ready_for_pickup` with no partner, older than
 *     UNCLAIMED_TIMEOUT_MS, get the nearest online partner with a fresh GPS.
 *   - Transport: same, but on `TransportOrder`s in status `placed`, with the
 *     added constraint that partner.vehicleType === order.vehicleId.
 *
 * Manual `/accept` (grocery) and `/transport/:id/accept` still win against
 * the auto-assigner — the atomic claim filter requires deliveryPartner to
 * still be null, so a manual grab in the same second still claims cleanly.
 */

const TICK_INTERVAL_MS = 60_000;
const UNCLAIMED_TIMEOUT_MS = 3 * 60_000;
const LOCATION_FRESHNESS_MS = 2 * 60_000;
const SEARCH_RADIUS_KM = 8;

let ticking = false;

export function startAutoAssign(io) {
  setInterval(() => runTick(io).catch((e) => console.error('[auto-assign]', e)), TICK_INTERVAL_MS);
  console.log(
    `[auto-assign] started — every ${TICK_INTERVAL_MS / 1000}s, ` +
      `timeout ${UNCLAIMED_TIMEOUT_MS / 1000}s, radius ${SEARCH_RADIUS_KM}km ` +
      `(grocery + transport)`
  );
}

async function runTick(io) {
  if (ticking) return;
  ticking = true;
  try {
    await Promise.all([sweepGrocery(io), sweepTransport(io)]);
  } finally {
    ticking = false;
  }
}

// ============================================================
// GROCERY (unchanged from 5b)
// ============================================================

async function sweepGrocery(io) {
  const cutoff = new Date(Date.now() - UNCLAIMED_TIMEOUT_MS);
  const orders = await Order.find({
    status: 'ready_for_pickup',
    deliveryPartner: { $in: [null, undefined] },
    updatedAt: { $lt: cutoff },
  })
    .sort({ updatedAt: 1 })
    .limit(10)
    .lean();
  if (orders.length === 0) return;
  for (const order of orders) await assignGroceryOne(io, order);
}

async function assignGroceryOne(io, order) {
  const shop = await Shop.findById(order.shop).select('location name').lean();
  if (!shop?.location?.coordinates) return;
  const freshSince = new Date(Date.now() - LOCATION_FRESHNESS_MS);

  const partner = await DeliveryProfile.findOne({
    available: true,
    'currentLocation.coordinates': { $exists: true },
    'currentLocation.updatedAt': { $gte: freshSince },
    currentLocation: {
      $nearSphere: {
        $geometry: { type: 'Point', coordinates: shop.location.coordinates },
        $maxDistance: SEARCH_RADIUS_KM * 1000,
      },
    },
  }).lean();
  if (!partner) return;

  const claimed = await Order.findOneAndUpdate(
    {
      _id: order._id,
      status: 'ready_for_pickup',
      deliveryPartner: { $in: [null, undefined] },
    },
    {
      $set: { deliveryPartner: partner.user },
      $push: {
        statusHistory: {
          status: 'ready_for_pickup',
          by: partner.user,
          note: 'Auto-assigned (idle timeout)',
        },
      },
    },
    { new: true }
  );
  if (!claimed) return;

  console.log(
    `[auto-assign] grocery order ${claimed._id} → partner ${partner.user} (shop "${shop.name}")`
  );
  const payload = {
    orderId: claimed._id.toString(),
    shopId: claimed.shop.toString(),
    status: claimed.status,
    deliveryPartner: partner.user.toString(),
    at: Date.now(),
  };
  io.to(`shop:${claimed.shop}`).emit('order:status_update', payload);
  io.to(`order:${claimed._id}`).emit('order:status_update', payload);
  io.to('delivery:available').emit('job:taken', { orderId: claimed._id.toString() });
  io.to(`user:${partner.user}`).emit('job:assigned', {
    orderId: claimed._id.toString(),
  });
}

// ============================================================
// TRANSPORT (6b.2 — new)
// ============================================================

async function sweepTransport(io) {
  const cutoff = new Date(Date.now() - UNCLAIMED_TIMEOUT_MS);
  const orders = await TransportOrder.find({
    status: 'placed',
    deliveryPartner: { $in: [null, undefined] },
    updatedAt: { $lt: cutoff },
  })
    .sort({ updatedAt: 1 })
    .limit(10)
    .lean();
  if (orders.length === 0) return;
  for (const order of orders) await assignTransportOne(io, order);
}

async function assignTransportOne(io, order) {
  const pickupCoords = order.pickup?.location?.coordinates;
  if (!pickupCoords) return;
  const freshSince = new Date(Date.now() - LOCATION_FRESHNESS_MS);

  // The extra filter vs grocery: vehicleType must match the booked vehicle.
  // (A bike partner doesn't get auto-assigned a Tata 407 transport job.)
  const partner = await DeliveryProfile.findOne({
    available: true,
    vehicleType: order.vehicleId,
    'currentLocation.coordinates': { $exists: true },
    'currentLocation.updatedAt': { $gte: freshSince },
    currentLocation: {
      $nearSphere: {
        $geometry: { type: 'Point', coordinates: pickupCoords },
        $maxDistance: SEARCH_RADIUS_KM * 1000,
      },
    },
  }).lean();
  if (!partner) return;

  // Atomic claim: same first-wins shape, also flips status to 'accepted'.
  const claimed = await TransportOrder.findOneAndUpdate(
    {
      _id: order._id,
      status: 'placed',
      vehicleId: order.vehicleId, // belt-and-braces
      deliveryPartner: { $in: [null, undefined] },
    },
    {
      $set: { deliveryPartner: partner.user, status: 'accepted' },
      $push: {
        statusHistory: {
          status: 'accepted',
          by: partner.user,
          note: 'Auto-assigned (idle timeout)',
        },
      },
    },
    { new: true }
  );
  if (!claimed) return;

  console.log(
    `[auto-assign] transport ${claimed._id} → partner ${partner.user} (vehicle ${order.vehicleId})`
  );
  const payload = {
    orderId: claimed._id.toString(),
    status: claimed.status,
    deliveryPartner: partner.user.toString(),
    at: Date.now(),
    kind: 'transport',
  };
  io.to(`order:${claimed._id}`).emit('order:status_update', payload);
  io.to('delivery:available').emit('job:taken', {
    orderId: claimed._id.toString(),
    kind: 'transport',
  });
  io.to(`user:${partner.user}`).emit('job:assigned', {
    orderId: claimed._id.toString(),
    kind: 'transport',
  });
}
