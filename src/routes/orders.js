import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';

import { Order, Product, Shop } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/role.js';
import { validateBody } from '../utils/validate.js';
import { calculateOrderTotals, distanceKm } from '../services/pricing.js';
import { createRazorpayOrder } from '../services/razorpay.js';
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

      // Notify shops
      const io = req.app.get('io');
      for (const order of createdOrders) {
        io.to(`shop:${order.shop}`).emit('order:new', { orderId: order._id.toString() });
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
