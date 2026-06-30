import { Router } from 'express';
import { z } from 'zod';

import { Booking, Shop } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { validateBody } from '../utils/validate.js';
import { sendPushToUser } from '../services/push.js';
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

export default router;
