import { Product } from '../models/index.js';

/**
 * Stock convention used across the app:
 *   stock === 0  →  "untracked / unlimited" (services, or shops not tracking
 *                   inventory). We never touch these.
 *   stock  >  0  →  tracked inventory. Decrement on order confirmation,
 *                   restore on cancellation/refund.
 *
 * Decrement is atomic and guarded: the update only applies if there's still
 * enough stock at write time (`stock: { $gte: qty }`), so two customers buying
 * the last unit at the same instant can't both succeed. This is the safety net
 * on top of the up-front check in checkout (which can race under concurrency).
 */

/**
 * Atomically decrement stock for a list of order items.
 * @param {Array<{product: any, qty: number}>} items
 * @returns {Promise<{ ok: boolean, failed: Array<string> }>}
 *   ok=false means at least one tracked item didn't have enough stock; `failed`
 *   lists those product ids. Caller decides how to handle (we log + continue,
 *   since the order is already placed — see note in the route).
 */
export async function decrementStock(items) {
  const failed = [];

  await Promise.all(
    items.map(async (it) => {
      const productId = it.product?._id || it.product;
      const qty = it.qty;
      if (!productId || !qty) return;

      // Only decrement tracked products (stock > 0). The guard {$gte: qty}
      // ensures we never go negative and resolves the last-unit race.
      const res = await Product.updateOne(
        { _id: productId, stock: { $gte: qty, $gt: 0 } },
        { $inc: { stock: -qty } }
      );

      // matchedCount 0 means either untracked (stock 0 — fine) OR not enough
      // stock. Distinguish by re-reading only when nothing matched.
      if (res.matchedCount === 0) {
        const p = await Product.findById(productId).select('stock').lean();
        if (p && p.stock > 0 && p.stock < qty) {
          failed.push(productId.toString());
        }
      }
    })
  );

  return { ok: failed.length === 0, failed };
}

/**
 * Restore stock for a list of order items (on cancellation/refund).
 *
 * CAVEAT: after the fact we can't perfectly tell whether a product was
 * "untracked" (stock 0 = unlimited) at order time, so this always increments.
 * For normal tracked inventory this is correct. If you have untracked products
 * AND start restoring stock on cancellations, record an `wasTracked` flag on
 * the order item at checkout and gate restoration on it. Not wired to any flow
 * yet — provided so the cancel/refund path can use it when you build it.
 */
export async function restoreStock(items) {
  await Promise.all(
    items.map(async (it) => {
      const productId = it.product?._id || it.product;
      const qty = it.qty;
      if (!productId || !qty) return;
      await Product.updateOne({ _id: productId }, { $inc: { stock: qty } });
    })
  );
}
