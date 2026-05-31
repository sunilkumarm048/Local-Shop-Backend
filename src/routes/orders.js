import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';

import { Order, Product, Shop } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/role.js';
import { validateBody } from '../utils/validate.js';
import { calculateOrderTotals, distanceKm } from '../services/pricing.js';
import { createRazorpayOrder } from '../services/razorpay.js';
import { decrementStock } from '../services/inventory.js';
import { sendPushToUser } from '../services/push.js';
import { HttpError } from '../middleware/error.js';

const router = Router();

const checkoutSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        qty: z.number().int().min(1).max(100),
      })
    )
    .min(1),
  recipient: z.object({
    name: z.string().min(1),
    phone: z.string().min(10),
    address: z.string().min(1),
    location: z.object({
      lng: z.number(),
      lat: z.number(),
    }),
  }),
  vehicleId: z.enum(['bike', '3wheeler', 'tataAce', 'pickup8ft', 'tata407']).default('bike'),
  paymentMethod: z.enum(['razorpay', 'cod']).default('razorpay'),
});

/**
 * POST /api/orders/checkout
 *
 * The big one. Steps:
 *   1. Look up every product. Group by shop. Reject if any product is missing/out-of-stock.
 *   2. For each shop, compute distance, totals server-side.
 *   3. Create one Order per shop (status: pending_payment) — all share a cartId.
 *   4. If razorpay: create a Razorpay order for the SUM total, return its key for the modal.
 *   5. If cod: mark orders as 'placed' directly, emit socket events.
 *
 * Returns:
 *   {
 *     cartId,
 *     orders: [{id, shopId, total, ...}],
 *     grandTotal,
 *     payment: { method, razorpayOrderId?, razorpayKeyId? }
 *   }
 */
router.post('/checkout', requireAuth, async (req, res, next) => {
  try {
    const data = validateBody(req, checkoutSchema);
    const userId = req.user._id;

    const productIds = data.items.map((i) => i.productId);
    const products = await Product.find({ _id: { $in: productIds }, isActive: true }).populate(
      'shop'
    );

    if (products.length !== productIds.length) {
      throw new HttpError(400, 'One or more products are no longer available');
    }

    // Group items by shop
    const byShop = new Map(); // shopId -> { shop, items: [{product, qty}] }
    for (const cartItem of data.items) {
      const product = products.find((p) => p._id.toString() === cartItem.productId);
      const shop = product.shop;
      if (!shop || shop.isBlocked || !shop.isOpen) {
        throw new HttpError(400, `Shop "${shop?.name || 'unknown'}" is not accepting orders`);
      }
      if (product.stock > 0 && product.stock < cartItem.qty) {
        throw new HttpError(400, `Not enough stock for "${product.name}"`);
      }

      const shopId = shop._id.toString();
      if (!byShop.has(shopId)) byShop.set(shopId, { shop, items: [] });
      byShop.get(shopId).items.push({ product, qty: cartItem.qty });
    }

    const isSplit = byShop.size > 1;
    const cartId = crypto.randomUUID();
    const recipientPoint = [data.recipient.location.lng, data.recipient.location.lat];

    const createdOrders = [];
    let grandTotal = 0;

    for (const { shop, items } of byShop.values()) {
      const km = shop.location?.coordinates
        ? Number(distanceKm(shop.location.coordinates, recipientPoint).toFixed(2))
        : null;

      const orderItems = items.map(({ product, qty }) => ({
        product: product._id,
        name: product.name,
        price: product.price,
        qty,
        weight: product.weight,
        image: product.image,
      }));

      const totals = await calculateOrderTotals({
        items: orderItems,
        vehicleId: data.vehicleId,
        distanceKm: km,
        shop,
      });

      const order = await Order.create({
        cartId,
        customer: userId,
        shop: shop._id,
        shopEmail: shop.ownerEmail,
        items: orderItems,
        subtotal: totals.subtotal,
        discount: totals.discount,
        handlingFee: totals.handlingFee,
        platformFee: totals.platformFee,
        deliveryFee: totals.deliveryFee,
        total: totals.total,
        deliveryMode: 'delivery',
        vehicleId: data.vehicleId,
        distanceKm: km,
        recipient: {
          name: data.recipient.name,
          phone: data.recipient.phone,
          address: data.recipient.address,
          location: { type: 'Point', coordinates: recipientPoint },
        },
        status: 'pending_payment',
        statusHistory: [{ status: 'pending_payment', by: userId }],
        payment: {
          method: data.paymentMethod,
          status: 'pending',
        },
        isSplit,
      });

      createdOrders.push(order);
      grandTotal += order.total;
    }

    // Payment
    let paymentBlock;
    if (data.paymentMethod === 'razorpay') {
      const rp = await createRazorpayOrder({
        amountInr: grandTotal,
        receipt: cartId,
        notes: { cartId, userId: userId.toString() },
      });
      // Stamp the razorpay orderId on each Order
      await Order.updateMany(
        { cartId },
        { $set: { 'payment.razorpayOrderId': rp.id } }
      );
      paymentBlock = {
        method: 'razorpay',
        razorpayOrderId: rp.id,
        razorpayKeyId: process.env.RAZORPAY_KEY_ID,
        amount: rp.amount,
        currency: rp.currency,
      };
    } else {
      // COD — mark placed immediately, no money flow
      await Order.updateMany(
        { cartId },
        {
          $set: { status: 'placed', placedAt: new Date() },
          $push: { statusHistory: { status: 'placed', by: userId } },
        }
      );
      paymentBlock = { method: 'cod' };

      // Decrement tracked stock now that the order is confirmed. Atomic +
      // guarded inside the helper. The order is already placed, so we don't
      // fail the request if a rare race leaves a shortfall — we log it for the
      // shop to reconcile (better than rejecting an order the customer thinks
      // succeeded). The up-front check above catches the normal case.
      for (const order of createdOrders) {
        const { ok, failed } = await decrementStock(order.items);
        if (!ok) {
          // eslint-disable-next-line no-console
          console.warn(
            `[inventory] COD order ${order._id} oversold products:`,
            failed.join(', ')
          );
        }
      }

      // Notify shops
      const io = req.app.get('io');
      for (const order of createdOrders) {
        io.to(`shop:${order.shop}`).emit('order:new', { orderId: order._id.toString() });

        // PHASE 8h: also fire web push so the owner is alerted even if their
        // dashboard tab is closed / phone is asleep. Look up the shop's owner;
        // fire-and-forget so failures here never block checkout.
        (async () => {
          try {
            const shop = await Shop.findById(order.shop).select('owner name').lean();
            if (shop?.owner) {
              await sendPushToUser(shop.owner, {
                title: 'New order',
                body: `New order at ${shop.name || 'your shop'} — \u20B9${order.total}`,
                tag: `order:${order._id}`,
                url: '/shop',
                orderId: order._id.toString(),
              });
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[push] order:new push failed (non-blocking):', err.message);
          }
        })();
      }
    }

    res.status(201).json({
      cartId,
      orders: createdOrders.map((o) => ({
        id: o._id.toString(),
        shopId: o.shop.toString(),
        total: o.total,
        status: o.status,
      })),
      grandTotal,
      payment: paymentBlock,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/orders/mine — current customer's orders, most recent first
 */
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const orders = await Order.find({ customer: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('shop', 'name logo location')
      .lean();
    res.json({ orders });
  } catch (err) {
    next(err);
  }
});

/* ============================================================
 * PHASE 4b — Shop-owner order management
 *
 * The customer-facing handlers above create Orders and let customers
 * view their own. These handlers let a shop owner see the orders for
 * their shop and drive the fulfilment lifecycle:
 *
 *   placed → accepted → preparing → ready_for_pickup
 *               └────────→ cancelled   (reject)
 *
 * Every transition:
 *   - appends to statusHistory
 *   - emits `order:status_update` to BOTH the shop room (owner's other
 *     tabs/devices) and the order room (customer tracking page)
 *
 * Split orders: a multi-shop checkout creates one Order per shop, all
 * sharing a `cartId` with `isSplit: true`. Each shop owner only sees and
 * acts on their own Order — but we expose GET /:id/siblings so the owner
 * can see how the sibling shops are progressing (the legacy
 * split-order.html surfaced this).
 * ============================================================ */

// Which status a shop owner is allowed to move an order TO, given its
// current status. Anything not listed is rejected with 409.
const OWNER_TRANSITIONS = {
  placed: ['accepted', 'cancelled'],
  accepted: ['preparing', 'cancelled'],
  preparing: ['ready_for_pickup', 'cancelled'],
  // ready_for_pickup onward is the delivery partner's domain (Phase 5)
};

/**
 * Load an order and assert the current user owns the shop it belongs to.
 * Returns the (non-lean) order document so the caller can mutate + save.
 */
async function assertOrderShopOwner(req, orderId) {
  const order = await Order.findById(orderId);
  if (!order) throw new HttpError(404, 'Order not found');
  const ownsShop = await Shop.exists({ _id: order.shop, owner: req.user._id });
  if (!ownsShop) throw new HttpError(403, 'You do not manage this shop');
  return order;
}

/**
 * Emit a status-change event to everyone who cares about this order.
 * - shop:<shopId>  → the owner's dashboard + other devices
 * - order:<orderId> → the customer's tracking page (and later, delivery)
 *
 * Also fires a push to the customer so they're alerted even with the app
 * closed (their tracking page won't help much if their phone is in their
 * pocket). Fire-and-forget; failures here never block the status change.
 */
function emitStatusUpdate(req, order) {
  const io = req.app.get('io');
  if (!io) return;
  const payload = {
    orderId: order._id.toString(),
    shopId: order.shop.toString(),
    cartId: order.cartId,
    status: order.status,
    at: Date.now(),
  };
  io.to(`shop:${order.shop}`).emit('order:status_update', payload);
  io.to(`order:${order._id}`).emit('order:status_update', payload);

  // Push to customer
  if (order.customer) {
    (async () => {
      try {
        await sendPushToUser(order.customer, {
          title: customerPushTitle(order.status),
          body: customerPushBody(order.status),
          tag: `order:${order._id}`,
          url: `/orders/${order._id}`,
          orderId: order._id.toString(),
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[push] order status push to customer failed:', err.message);
      }
    })();
  }
}

/** Friendly status-change copy for customer push notifications. */
function customerPushTitle(status) {
  switch (status) {
    case 'accepted': return 'Order accepted';
    case 'preparing': return 'Your order is being prepared';
    case 'ready_for_pickup': return 'Order ready for pickup';
    case 'out_for_delivery': return 'On the way';
    case 'delivered': return 'Delivered \u2705';
    case 'cancelled': return 'Order cancelled';
    case 'rejected': return 'Order rejected';
    default: return 'Order update';
  }
}

function customerPushBody(status) {
  switch (status) {
    case 'accepted': return 'The shop has accepted your order.';
    case 'preparing': return 'The shop is preparing your items now.';
    case 'ready_for_pickup': return 'Your order is ready and waiting for a delivery partner.';
    case 'out_for_delivery': return 'Your delivery partner is on the way \u2014 tap to track.';
    case 'delivered': return 'Your order has been delivered. Thanks for shopping local!';
    case 'cancelled': return 'Your order was cancelled. Tap for details.';
    case 'rejected': return 'The shop couldn\u2019t accept your order. Tap for details.';
    default: return 'There\u2019s an update on your order.';
  }
}

/**
 * GET /api/orders/shop/:shopId
 *   ?status=placed|accepted|preparing|ready_for_pickup|active|all
 *
 * Lists orders for a shop the caller owns. `status=active` (the default)
 * returns everything still in flight — i.e. not delivered/cancelled/refunded.
 */
router.get('/shop/:shopId', requireAuth, requireRole('shop'), async (req, res, next) => {
  try {
    const ownsShop = await Shop.exists({ _id: req.params.shopId, owner: req.user._id });
    if (!ownsShop) throw new HttpError(403, 'You do not manage this shop');

    const { status = 'active', limit = '100' } = req.query;
    const filter = { shop: req.params.shopId };

    if (status === 'active') {
      filter.status = { $nin: ['delivered', 'cancelled', 'refunded', 'pending_payment'] };
    } else if (status !== 'all') {
      filter.status = String(status);
    }

    const orders = await Order.find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 100, 200))
      .lean();

    res.json({ orders });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/orders/:id/siblings — the other Orders sharing this order's cartId.
 *
 * For a split order, lets the owner see how sibling shops are doing.
 * Only the items/shop/status of siblings are exposed — not customer PII
 * beyond what's already on the owner's own order.
 */
router.get('/:id/siblings', requireAuth, requireRole('shop'), async (req, res, next) => {
  try {
    const order = await assertOrderShopOwner(req, req.params.id);
    if (!order.cartId || !order.isSplit) {
      return res.json({ siblings: [] });
    }
    const siblings = await Order.find({
      cartId: order.cartId,
      _id: { $ne: order._id },
    })
      .populate('shop', 'name logo')
      .select('shop status items total createdAt')
      .lean();
    res.json({ siblings });
  } catch (err) {
    next(err);
  }
});

const statusPatchSchema = z.object({
  status: z.enum(['accepted', 'preparing', 'ready_for_pickup', 'cancelled']),
  note: z.string().max(300).optional(),
});

/**
 * PATCH /api/orders/:id/status — owner drives the fulfilment lifecycle.
 *
 * Body: { status, note? }
 * The transition must be legal per OWNER_TRANSITIONS or we 409.
 */
router.patch('/:id/status', requireAuth, requireRole('shop'), async (req, res, next) => {
  try {
    const { status, note } = validateBody(req, statusPatchSchema);
    const order = await assertOrderShopOwner(req, req.params.id);

    const allowed = OWNER_TRANSITIONS[order.status] || [];
    if (!allowed.includes(status)) {
      throw new HttpError(
        409,
        `Cannot move an order from "${order.status}" to "${status}"`
      );
    }

    order.status = status;
    order.statusHistory.push({ status, by: req.user._id, note });
    if (status === 'cancelled') {
      // Owner rejected the order. If it was a paid (razorpay) order, the
      // refund flow is handled separately in payments — we just flag intent.
      order.statusHistory.push({
        status: 'cancelled',
        by: req.user._id,
        note: note || 'Rejected by shop',
      });
    }
    await order.save();

    emitStatusUpdate(req, order);

    res.json({ order });
  } catch (err) {
    next(err);
  }
});

/**
 * Convenience aliases — the dashboard calls these instead of building the
 * PATCH body itself. They all funnel through the same transition guard.
 */
async function ownerTransition(req, res, next, targetStatus, defaultNote) {
  try {
    const order = await assertOrderShopOwner(req, req.params.id);
    const allowed = OWNER_TRANSITIONS[order.status] || [];
    if (!allowed.includes(targetStatus)) {
      throw new HttpError(
        409,
        `Cannot move an order from "${order.status}" to "${targetStatus}"`
      );
    }
    order.status = targetStatus;
    order.statusHistory.push({
      status: targetStatus,
      by: req.user._id,
      note: req.body?.note || defaultNote,
    });
    await order.save();
    emitStatusUpdate(req, order);
    res.json({ order });
  } catch (err) {
    next(err);
  }
}

router.post('/:id/accept', requireAuth, requireRole('shop'), (req, res, next) =>
  ownerTransition(req, res, next, 'accepted', 'Accepted by shop')
);
router.post('/:id/reject', requireAuth, requireRole('shop'), (req, res, next) =>
  ownerTransition(req, res, next, 'cancelled', 'Rejected by shop')
);
router.post('/:id/preparing', requireAuth, requireRole('shop'), (req, res, next) =>
  ownerTransition(req, res, next, 'preparing', 'Shop started preparing')
);
router.post('/:id/ready', requireAuth, requireRole('shop'), (req, res, next) =>
  ownerTransition(req, res, next, 'ready_for_pickup', 'Ready for pickup')
);

/**
 * GET /api/orders/:id — must belong to caller or their shop or their delivery
 */
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('shop', 'name logo location phone')
      .lean();
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const uid = req.user._id.toString();
    const isCustomer = order.customer.toString() === uid;
    const isDelivery = order.deliveryPartner?.toString() === uid;
    const isShopOwner =
      req.user.roles.includes('shop') &&
      (await Shop.exists({ _id: order.shop, owner: req.user._id }));
    const isAdmin = req.user.roles.includes('admin');

    if (!isCustomer && !isDelivery && !isShopOwner && !isAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    res.json({ order });
  } catch (err) {
    next(err);
  }
});

export default router;
