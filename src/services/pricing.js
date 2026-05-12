import { PricingConfig } from '../models/index.js';

/**
 * Pricing service — the server-side source of truth for all money math.
 * The client may show estimates, but every order's total is recomputed here
 * before charging the customer. NEVER trust amounts from the client.
 */

/**
 * Haversine distance (kilometres) between two [lng, lat] points.
 * Accurate enough for delivery-fee calculations within a city.
 */
export function distanceKm([lng1, lat1], [lng2, lat2]) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Choose the smallest vehicle that can carry `weightKg`.
 * Customers can manually upgrade for fragile/bulky goods.
 */
export function suggestVehicle(weightKg, vehicles) {
  const ordered = Object.values(vehicles).sort((a, b) => a.maxKg - b.maxKg);
  return ordered.find((v) => weightKg <= v.maxKg) || ordered[ordered.length - 1];
}

/**
 * Calculate the delivery fee for a given vehicle + distance.
 * Formula: max(minFee, perKmRate × distanceKm), rounded up.
 */
export function deliveryFee(vehicle, km) {
  const raw = Math.max(vehicle.minFee, vehicle.perKmRate * km);
  return Math.ceil(raw);
}

/**
 * Compute the full money breakdown for an order. Single source of truth.
 *
 *   {
 *     items: [{ price, qty }, ...],
 *     vehicle, distanceKm,
 *     shop  (for shop-specific discount)
 *   }
 */
export async function calculateOrderTotals({ items, vehicleId, distanceKm: km, shop }) {
  const cfg = await PricingConfig.getCurrent();

  const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);

  // Discount: shop-specific overrides global
  let discount = { amount: 0, label: '', source: 'none' };
  const shopDisc = shop?.discount;
  const globalDisc = cfg.globalDiscount;

  const applyDiscount = (d, source) => {
    if (!d?.enabled) return null;
    const amt = d.type === 'percent' ? (subtotal * d.value) / 100 : d.value;
    return { amount: Math.round(amt), label: d.label || '', source };
  };

  discount = applyDiscount(shopDisc, 'shop') || applyDiscount(globalDisc, 'global') || discount;

  const vehicle = cfg.vehicles[vehicleId];
  const delivery = vehicle && km != null ? deliveryFee(vehicle, km) : 0;

  const handlingFee = cfg.handlingFee || 0;
  const taxable = Math.max(0, subtotal - discount.amount) + delivery + handlingFee;
  const platformFee = Math.round((taxable * (cfg.platformFeePercent || 0)) / 100);
  const total = taxable + platformFee;

  return {
    subtotal,
    discount,
    deliveryFee: delivery,
    handlingFee,
    platformFee,
    total,
    distanceKm: km,
    vehicleId,
  };
}
