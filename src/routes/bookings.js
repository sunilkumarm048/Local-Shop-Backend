import { Router } from 'express';
import { z } from 'zod';

import { Booking, Shop } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/role.js';
import { validateBody } from '../utils/validate.js';
import { sendPushToUser } from '../services/push.js';
import { emailNewBooking, emailBookingStatus } from '../services/email.js';
import { HttpError } from '../middleware/error.js';

const router = Router();

/* ----------------------------------------------------------------------------
 * Stage A — customer creates a service booking, and views their own bookings.
 * Provider accept/decline/advance is Stage B; review is Stage D.
 * No price, no payment — this is a scheduled visit request only.
 * -------------------------------------------------------------------------- */

const addressSchema = z.object({
  label: z.string().trim().max(40).optional(),
  line1: z.string().trim().max(120).optional(),
  line2: z.string().trim().max(120).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  pincode: z.string().trim().max(12).optional(),
  location: z.object({ lng: z.number(), lat: z.number() }).optional(),
});

const createBookingSchema = z
  .object({
    providerId: z.string().min(1),
    serviceName: z.string().trim().min(1).max(120),
    serviceCategory: z.string().min(1).optional(),
    // Either "request now" OR a scheduled date + slot.
    requestNow: z.boolean().optional(),
    scheduledDate: z.string().datetime().optional(),
    scheduledSlot: z.string().trim().max(40).optional(),
    address: addressSchema.optional(),
    contactName: z.string().trim().max(80).optional(),
    contactPhone: z.string().trim().max(20).optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .refine((d) => d.requestNow || (d.scheduledDate && d.scheduledSlot), {
    message: 'Pick a date and time slot, or choose "request now".',
  });

/**
 * POST /api/bookings — customer requests a service from a provider.
 */
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const data = validateBody(req, createBookingSchema);

    const provider = await Shop.findById(data.providerId)
      .populate({ path: 'category', populate: { path: 'parent' } })
      .lean();
    if (!provider || provider.isBlocked) {
      throw new HttpError(404, 'Service provider not found.');
    }

    // Guard against double-booking: refuse if the provider is already committed
    // to an active job (accepted through in_progress).
    const activeCount = await Booking.countDocuments({
      provider: provider._id,
      status: { $in: ['accepted', 'scheduled', 'on_the_way', 'in_progress'] },
    });
    if (activeCount > 0) {
      throw new HttpError(409, 'This provider is currently on a job. Please try again later.');
    }

    const booking = await Booking.create({
      customer: req.user._id,
      provider: provider._id,
      serviceName: data.serviceName,
      serviceCategory: data.serviceCategory || provider.category?._id,
      requestNow: !!data.requestNow,
      scheduledDate: data.scheduledDate ? new Date(data.scheduledDate) : undefined,
      scheduledSlot: data.scheduledSlot,
      address: data.address
        ? {
            ...data.address,
            location:
              data.address.location &&
              data.address.location.lng != null &&
              data.address.location.lat != null
                ? {
                    type: 'Point',
                    coordinates: [data.address.location.lng, data.address.location.lat],
                  }
                : undefined,
          }
        : undefined,
      contactName: data.contactName,
      contactPhone: data.contactPhone,
      notes: data.notes,
      status: 'requested',
      statusHistory: [{ status: 'requested', by: req.user._id }],
    });

    // Best-effort notify the provider's owner that a request came in.
    if (provider.owner) {
      sendPushToUser(provider.owner, {
        title: 'New service request',
        body: `${data.serviceName} — tap to view`,
        url: '/shop',
        tag: 'new-booking',
      }).catch(() => {});
      emailNewBooking(provider.owner, {
        serviceName: data.serviceName,
        customerName: data.contactName || req.user?.name,
        when: data.requestNow ? 'As soon as possible' : data.scheduledAt,
        address: data.address
          ? [data.address.line1, data.address.city].filter(Boolean).join(', ')
          : undefined,
      }).catch(() => {});
    }

    res.status(201).json({ booking });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/bookings/mine — the signed-in customer's bookings, newest first.
 */
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const bookings = await Booking.find({ customer: req.user._id })
      .populate({ path: 'provider', select: 'name logo phone location' })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ bookings });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/bookings/:id — a single booking the customer owns.
 */
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id)
      .populate({ path: 'provider', select: 'name logo phone location' })
      .lean();
    if (!booking) throw new HttpError(404, 'Booking not found.');
    // Only the customer who made it can view it here (provider views come in Stage B).
    if (String(booking.customer) !== String(req.user._id)) {
      throw new HttpError(403, 'Not your booking.');
    }
    res.json({ booking });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/bookings/:id/cancel — customer cancels their own booking.
 */
router.patch('/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) throw new HttpError(404, 'Booking not found.');
    if (String(booking.customer) !== String(req.user._id)) {
      throw new HttpError(403, 'Not your booking.');
    }
    if (['completed', 'cancelled', 'declined'].includes(booking.status)) {
      throw new HttpError(400, 'This booking can no longer be cancelled.');
    }
    booking.status = 'cancelled';
    booking.cancelReason = (req.body?.reason || '').toString().slice(0, 200) || undefined;
    booking.statusHistory.push({ status: 'cancelled', by: req.user._id });
    await booking.save();
    res.json({ booking });
  } catch (err) {
    next(err);
  }
});

/* ----------------------------------------------------------------------------
 * Stage B — provider side. A service provider (shop owner) sees bookings made
 * to their shop(s) and moves them through the lifecycle.
 * -------------------------------------------------------------------------- */

/**
 * Allowed forward transitions a PROVIDER can make from each status. Keeps the
 * lifecycle honest (e.g. you can't jump from requested straight to completed).
 */
const PROVIDER_TRANSITIONS = {
  requested: ['accepted', 'declined'],
  accepted: ['scheduled', 'on_the_way', 'cancelled'],
  scheduled: ['on_the_way', 'cancelled'],
  on_the_way: ['in_progress', 'cancelled'],
  in_progress: ['completed'],
};

async function providerShopIds(userId) {
  const shops = await Shop.find({ owner: userId }).select('_id').lean();
  return shops.map((s) => s._id);
}

/**
 * GET /api/bookings/provider/incoming — bookings made to the provider's shops.
 * Optional ?status= filter; defaults to all, newest first.
 */
router.get(
  '/provider/incoming',
  requireAuth,
  requireRole('shop'),
  async (req, res, next) => {
    try {
      const shopIds = await providerShopIds(req.user._id);
      if (shopIds.length === 0) return res.json({ bookings: [] });

      const filter = { provider: { $in: shopIds } };
      if (req.query.status) filter.status = String(req.query.status);

      const bookings = await Booking.find(filter)
        .populate({ path: 'customer', select: 'name phone avatar' })
        .populate({ path: 'provider', select: 'name' })
        .sort({ createdAt: -1 })
        .lean();
      res.json({ bookings });
    } catch (err) {
      next(err);
    }
  }
);

const statusUpdateSchema = z.object({
  status: z.enum([
    'accepted',
    'declined',
    'scheduled',
    'on_the_way',
    'in_progress',
    'completed',
    'cancelled',
  ]),
  note: z.string().trim().max(200).optional(),
  // Provider can confirm/adjust the scheduled time when accepting/scheduling.
  scheduledDate: z.string().datetime().optional(),
  scheduledSlot: z.string().trim().max(40).optional(),
});

/**
 * PATCH /api/bookings/:id/status — provider advances a booking's status.
 */
router.patch(
  '/:id/status',
  requireAuth,
  requireRole('shop'),
  async (req, res, next) => {
    try {
      const data = validateBody(req, statusUpdateSchema);
      const booking = await Booking.findById(req.params.id);
      if (!booking) throw new HttpError(404, 'Booking not found.');

      // Must be a booking to one of this provider's shops.
      const shopIds = await providerShopIds(req.user._id);
      const owns = shopIds.some((id) => String(id) === String(booking.provider));
      if (!owns) throw new HttpError(403, 'Not your booking.');

      const allowed = PROVIDER_TRANSITIONS[booking.status] || [];
      if (!allowed.includes(data.status)) {
        throw new HttpError(
          400,
          `Cannot move a "${booking.status}" booking to "${data.status}".`
        );
      }

      booking.status = data.status;
      if (data.scheduledDate) booking.scheduledDate = new Date(data.scheduledDate);
      if (data.scheduledSlot) booking.scheduledSlot = data.scheduledSlot;
      if (data.status === 'completed') booking.completedAt = new Date();
      booking.statusHistory.push({
        status: data.status,
        by: req.user._id,
        note: data.note,
      });
      await booking.save();

      // Notify the customer of the update.
      const labels = {
        accepted: 'Your booking was accepted',
        declined: 'Your booking was declined',
        scheduled: 'Your booking is scheduled',
        on_the_way: 'Your provider is on the way',
        in_progress: 'Your service has started',
        completed: 'Your service is complete',
        cancelled: 'Your booking was cancelled',
      };
      if (labels[data.status]) {
        sendPushToUser(booking.customer, {
          title: labels[data.status],
          body: booking.serviceName,
        }).catch(() => {});
        emailBookingStatus(booking.customer, {
          serviceName: booking.serviceName,
          status: data.status,
        }).catch(() => {});
      }

      res.json({ booking });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
  
