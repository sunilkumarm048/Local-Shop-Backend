import { Order, TransportOrder, Booking } from '../models/index.js';

/**
 * Analytics aggregation helpers.
 *
 * Reused by both shop owner and delivery partner analytics endpoints.
 * Everything is bounded by date range (default last 30 days) and a filter
 * (shopId for shop owner, deliveryPartner userId for delivery partner).
 *
 * All series are dense — we explicitly emit zero entries for days where no
 * orders happened, so the frontend bars line up nicely.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Round `ts` down to start-of-UTC-day. */
function toDayKey(ts) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** "YYYY-MM-DD" string from an epoch ms day key. */
function dayKeyLabel(key) {
  const d = new Date(key);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Build a dense day-by-day series with one bucket per UTC day.
 * Each bucket has `{ day, orders, revenue }`. Orders excluded:
 *   - status=cancelled / refunded (didn't actually transact)
 *   - status=pending_payment (not yet committed)
 */
function denseDailySeries({ start, end, rows, valueKey = 'total' }) {
  // Map raw rows into day buckets.
  const buckets = new Map();
  for (const r of rows) {
    const day = toDayKey(r.createdAt || r.placedAt || r._id?.getTimestamp?.() || Date.now());
    const b = buckets.get(day) || { day, orders: 0, revenue: 0 };
    b.orders += 1;
    b.revenue += r[valueKey] || 0;
    buckets.set(day, b);
  }

  // Walk every day in range, filling zeros for missing buckets.
  const series = [];
  for (let t = toDayKey(start); t <= toDayKey(end); t += DAY_MS) {
    series.push(
      buckets.get(t) || { day: t, orders: 0, revenue: 0 }
    );
  }
  return series.map((b) => ({
    day: dayKeyLabel(b.day),
    orders: b.orders,
    revenue: Math.round(b.revenue),
  }));
}

// ============================================================
// SHOP analytics
// ============================================================

export async function shopAnalytics({ shopId, days = 30 }) {
  const end = new Date();
  const start = new Date(end.getTime() - days * DAY_MS);

  // Grocery orders for this shop.
  const orders = await Order.find({
    shop: shopId,
    status: { $nin: ['cancelled', 'refunded', 'pending_payment'] },
    createdAt: { $gte: start, $lte: end },
  })
    .select('total status items createdAt')
    .lean();

  const series = denseDailySeries({ start, end, rows: orders, valueKey: 'total' });

  // Summary KPIs.
  const totalOrders = orders.length;
  const totalRevenue = orders.reduce((s, o) => s + (o.total || 0), 0);
  const avgOrderValue = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0;
  const delivered = orders.filter((o) => o.status === 'delivered').length;
  const completionRate = totalOrders > 0 ? Math.round((delivered / totalOrders) * 100) : 0;

  // Top products by units sold.
  const productMap = new Map();
  for (const o of orders) {
    for (const item of o.items || []) {
      const key = String(item.product || item.productId || item._id || item.name);
      const existing = productMap.get(key) || {
        name: item.name || 'Unknown',
        qty: 0,
        revenue: 0,
      };
      existing.qty += item.qty || 0;
      existing.revenue += (item.price || 0) * (item.qty || 0);
      productMap.set(key, existing);
    }
  }
  const topProducts = Array.from(productMap.values())
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 5)
    .map((p) => ({ ...p, revenue: Math.round(p.revenue) }));

  // ---- Service bookings (for service providers: plumber, AC repair, etc.) ----
  // A shop can be a service provider instead of (or as well as) a product shop.
  // Bookings carry no money, so we track counts + completion, not revenue.
  const bookings = await Booking.find({
    provider: shopId,
    createdAt: { $gte: start, $lte: end },
  })
    .select('status createdAt completedAt')
    .lean();

  const totalBookings = bookings.length;
  const completedBookings = bookings.filter((b) => b.status === 'completed').length;
  const cancelledBookings = bookings.filter((b) =>
    ['cancelled', 'declined'].includes(b.status)
  ).length;
  const activeBookings = bookings.filter(
    (b) => !['completed', 'cancelled', 'declined'].includes(b.status)
  ).length;
  const bookingCompletionRate =
    totalBookings > 0 ? Math.round((completedBookings / totalBookings) * 100) : 0;

  // Dense per-day booking counts (reuse the same day-bucket walk).
  const bookingBuckets = new Map();
  for (const b of bookings) {
    const day = toDayKey(b.createdAt || Date.now());
    bookingBuckets.set(day, (bookingBuckets.get(day) || 0) + 1);
  }
  const bookingSeries = [];
  for (let t = toDayKey(start); t <= toDayKey(end); t += DAY_MS) {
    bookingSeries.push({ day: dayKeyLabel(t), bookings: bookingBuckets.get(t) || 0 });
  }

  return {
    range: { from: start.toISOString(), to: end.toISOString(), days },
    summary: { totalOrders, totalRevenue: Math.round(totalRevenue), avgOrderValue, completionRate, delivered },
    bookingSummary: {
      totalBookings,
      completedBookings,
      activeBookings,
      cancelledBookings,
      completionRate: bookingCompletionRate,
    },
    bookingSeries,
    series,
    topProducts,
  };
}

// ============================================================
// DELIVERY partner analytics
// ============================================================

export async function deliveryAnalytics({ userId, days = 30 }) {
  const end = new Date();
  const start = new Date(end.getTime() - days * DAY_MS);

  // We track both grocery (Order) and transport (TransportOrder) deliveries.
  // Earnings field name is the same ("fee") on both. We sum by deliveredAt
  // when available, otherwise updatedAt for safety.
  const [groceryRows, transportRows] = await Promise.all([
    Order.find({
      deliveryPartner: userId,
      status: 'delivered',
      $or: [
        { deliveredAt: { $gte: start, $lte: end } },
        { updatedAt: { $gte: start, $lte: end } },
      ],
    })
      .select('deliveryFee status createdAt deliveredAt updatedAt distanceKm')
      .lean(),
    TransportOrder.find({
      deliveryPartner: userId,
      status: 'delivered',
      $or: [
        { deliveredAt: { $gte: start, $lte: end } },
        { updatedAt: { $gte: start, $lte: end } },
      ],
    })
      .select('fee status createdAt deliveredAt updatedAt distanceKm')
      .lean(),
  ]);

  // Normalize both into one shape with a `total` (= earnings).
  const normalized = [
    ...groceryRows.map((o) => ({
      total: o.deliveryFee || 0,
      kind: 'grocery',
      createdAt: o.deliveredAt || o.updatedAt || o.createdAt,
      distanceKm: o.distanceKm || 0,
    })),
    ...transportRows.map((o) => ({
      total: o.fee || 0,
      kind: 'transport',
      createdAt: o.deliveredAt || o.updatedAt || o.createdAt,
      distanceKm: o.distanceKm || 0,
    })),
  ];

  const series = denseDailySeries({ start, end, rows: normalized, valueKey: 'total' });

  const totalDeliveries = normalized.length;
  const totalEarnings = normalized.reduce((s, o) => s + o.total, 0);
  const totalDistance = normalized.reduce((s, o) => s + (o.distanceKm || 0), 0);
  const avgEarningPerDelivery = totalDeliveries > 0 ? Math.round(totalEarnings / totalDeliveries) : 0;
  const groceryCount = normalized.filter((o) => o.kind === 'grocery').length;
  const transportCount = normalized.filter((o) => o.kind === 'transport').length;

  return {
    range: { from: start.toISOString(), to: end.toISOString(), days },
    summary: {
      totalDeliveries,
      totalEarnings: Math.round(totalEarnings),
      totalDistanceKm: Math.round(totalDistance * 10) / 10,
      avgEarningPerDelivery,
      groceryCount,
      transportCount,
    },
    series,
  };
}
