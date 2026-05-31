import { Order } from '../models/index.js';

/**
 * Cancels orders abandoned at the payment step.
 *
 * When a customer reaches checkout with Razorpay, we create the Order(s) as
 * `pending_payment` BEFORE the payment modal opens. If they close the modal
 * (or it fails silently), those orders would otherwise sit as pending_payment
 * forever — bloating the DB and skewing any "total orders" counts.
 *
 * This sweep marks any pending_payment order older than PENDING_TTL_MS as
 * `cancelled`. We do NOT restore stock here because stock is only decremented
 * once an order is actually paid/placed — a pending_payment order never held
 * any stock. (If that ever changes, call restoreStock here.)
 */

const TICK_INTERVAL_MS = 5 * 60_000; // sweep every 5 min
const PENDING_TTL_MS = 30 * 60_000; // cancel pending_payment older than 30 min

let ticking = false;

export function startPendingOrderCleanup() {
  setInterval(
    () => runTick().catch((e) => console.error('[pending-cleanup]', e)),
    TICK_INTERVAL_MS
  );
  console.log(
    `[pending-cleanup] started — every ${TICK_INTERVAL_MS / 60000}min, ` +
      `cancels pending_payment older than ${PENDING_TTL_MS / 60000}min`
  );
}

async function runTick() {
  if (ticking) return;
  ticking = true;
  try {
    const cutoff = new Date(Date.now() - PENDING_TTL_MS);
    const res = await Order.updateMany(
      {
        status: 'pending_payment',
        createdAt: { $lt: cutoff },
      },
      {
        $set: { status: 'cancelled', 'payment.status': 'failed' },
        $push: {
          statusHistory: { status: 'cancelled', note: 'Payment not completed' },
        },
      }
    );
    if (res.modifiedCount > 0) {
      console.log(
        `[pending-cleanup] cancelled ${res.modifiedCount} abandoned order(s)`
      );
    }
  } finally {
    ticking = false;
  }
}
