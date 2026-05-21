import { Order, Shop, DeliveryProfile } from '../models/index.js';

/**
 * PHASE 5b — Auto-assign idle pickups.
 *
 * Every UNCLAIMED_TIMEOUT_MS, an order sitting in `ready_for_pickup` with no
 * deliveryPartner gets handed to the nearest online partner whose location
 * was reported recently (within LOCATION_FRESHNESS_MS). Partners can still
 * grab manually before that — this is the fallback for slow nights.
 *
 * Why an in-process interval instead of a worker:
 *   - Render's free tier is single-instance, so process-local timers behave
 *   - One small SET keeps it idempotent if Render briefly runs two instances
 *     during a deploy
 *
 * Started once from server.js. The interval is a no-op when nothing matches.
 */

const TICK_INTERVAL_MS = 60_000;              // run every minute
const UNCLAIMED_TIMEOUT_MS = 3 * 60_000;      // 3 min — tweakable
const LOCATION_FRESHNESS_MS = 2 * 60_000;     // partner GPS must be ≤2 min old
const SEARCH_RADIUS_KM = 8;                   // how far to look for a partner

// Guards re-entry if a tick takes longer than the interval (slow Mongo, etc).
let ticking = false;

export function startAutoAssign(io) {
  setInterval(() => runTick(io).catch((e) => console.error('[auto-assign]', e)), TICK_INTERVAL_MS);
  console.log(
    `[auto-assign] started — every ${TICK_INTERVAL_MS / 1000}s, ` +
      `timeout ${UNCLAIMED_TIMEOUT_MS / 1000}s, radius ${SEARCH_RADIUS_KM}km`
  );
}

async function runTick(io) {
  if (ticking) return;
  ticking = true;
  try {
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

    for (const order of orders) {
      await assignOne(io, order);
    }
  } finally {
    ticking = false;
  }
}

async function assignOne(io, order) {
  // Need the shop's location to find the nearest partner.
  const shop = await Shop.findById(order.shop).select('location name').lean();
  if (!shop?.location?.coordinates) return;

  const freshSince = new Date(Date.now() - LOCATION_FRESHNESS_MS);

  // Nearest online partner with a recent GPS ping, in radius.
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

  if (!partner) {
    // Nobody close enough. Try again next tick — order stays unclaimed.
    return;
  }

  // Atomic claim: same first-wins guard as manual /accept. If a manual grab
  // beat us in the last few millis, this matches zero docs and we skip.
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
    `[auto-assign] order ${claimed._id} → partner ${partner.user} ` +
      `(shop "${shop.name}")`
  );

  // Same broadcasts the manual accept does — keeps clients in sync.
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
  // Direct nudge to the assigned partner so their UI refreshes.
  io.to(`user:${partner.user}`).emit('job:assigned', {
    orderId: claimed._id.toString(),
  });
}
