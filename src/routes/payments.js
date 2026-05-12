import { Router } from 'express';
import { z } from 'zod';

import { Order } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { validateBody } from '../utils/validate.js';
import { verifyPaymentSignature, verifyWebhookSignature } from '../services/razorpay.js';
import { HttpError } from '../middleware/error.js';

const router = Router();

const verifySchema = z.object({
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
});

/**
 * POST /api/payments/verify
 *
 * Called by the customer's browser after the Razorpay modal succeeds.
 * We re-verify the signature server-side (don't trust the client's "success"
 * callback alone) and mark every order in the cart as paid + placed.
 *
 * Emits `order:new` to each shop so their dashboard lights up in real-time.
 */
router.post('/verify', requireAuth, async (req, res, next) => {
  try {
    const data = validateBody(req, verifySchema);

    const ok = verifyPaymentSignature({
      orderId: data.razorpayOrderId,
      paymentId: data.razorpayPaymentId,
      signature: data.razorpaySignature,
    });
    if (!ok) throw new HttpError(400, 'Invalid payment signature');

    const orders = await Order.find({
      'payment.razorpayOrderId': data.razorpayOrderId,
      customer: req.user._id,
    });
    if (orders.length === 0) throw new HttpError(404, 'Orders not found');

    const now = new Date();
    await Order.updateMany(
      { 'payment.razorpayOrderId': data.razorpayOrderId, customer: req.user._id },
      {
        $set: {
          status: 'placed',
          placedAt: now,
          'payment.status': 'paid',
          'payment.razorpayPaymentId': data.razorpayPaymentId,
          'payment.razorpaySignature': data.razorpaySignature,
          'payment.paidAt': now,
        },
        $push: { statusHistory: { status: 'placed', by: req.user._id } },
      }
    );

    // Emit to each shop's room so their dashboard updates live
    const io = req.app.get('io');
    for (const order of orders) {
      io.to(`shop:${order.shop}`).emit('order:new', { orderId: order._id.toString() });
    }

    res.json({ ok: true, count: orders.length });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/payments/webhook
 *
 * Razorpay-initiated. Used for events that happen async (refunds, late
 * payment captures, payment.failed). The route is mounted with
 * `express.raw()` in app.js, so `req.body` is a Buffer here.
 *
 * IMPORTANT: respond 2xx fast. Razorpay retries non-2xx aggressively.
 */
router.post('/webhook', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const rawBody = req.body; // Buffer because of express.raw

  if (!signature || !rawBody) return res.status(400).json({ error: 'Missing signature' });

  const valid = verifyWebhookSignature({ rawBody: rawBody.toString('utf8'), signature });
  if (!valid) return res.status(400).json({ error: 'Invalid signature' });

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  try {
    switch (event.event) {
      case 'payment.captured': {
        const rpOrderId = event.payload?.payment?.entity?.order_id;
        if (rpOrderId) {
          await Order.updateMany(
            { 'payment.razorpayOrderId': rpOrderId, 'payment.status': 'pending' },
            { $set: { 'payment.status': 'paid', 'payment.paidAt': new Date() } }
          );
        }
        break;
      }
      case 'payment.failed': {
        const rpOrderId = event.payload?.payment?.entity?.order_id;
        if (rpOrderId) {
          await Order.updateMany(
            { 'payment.razorpayOrderId': rpOrderId, status: 'pending_payment' },
            { $set: { 'payment.status': 'failed' } }
          );
        }
        break;
      }
      case 'refund.processed': {
        const paymentId = event.payload?.refund?.entity?.payment_id;
        if (paymentId) {
          await Order.updateMany(
            { 'payment.razorpayPaymentId': paymentId },
            { $set: { 'payment.status': 'refunded', status: 'refunded' } }
          );
        }
        break;
      }
      default:
        // ignore unhandled events
        break;
    }
  } catch (err) {
    console.error('[webhook] handler error:', err);
    // Still return 200 so Razorpay doesn't keep retrying a bug on our side
  }

  res.json({ ok: true });
});

export default router;
