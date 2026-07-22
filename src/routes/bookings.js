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

/* ------------------------- booking slots ------------------------- */

// India Standard Time offset — slot times ("09:00") are provider-local IST
// while the server clock is UTC. Single-market assumption, kept explicit.
const IST_OFFSET_MIN = 330;

const ACTIVE_SLOT_STATUSES = ['requested', 'accepted', 'scheduled', 'on_the_way', 'in_progress'];

function toMinutes(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

function fmt12(totalMin) {
  let h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
}

/** Generate slot labels for a provider's config: ["9:00 AM – 10:00 AM", ...] */
function generateSlots(cfg) {
  const startMin = toMinutes(cfg?.start) ?? 9 * 60;
  const endMin = toMinutes(cfg?.end) ?? 18 * 60;
  const step = Number(cfg?.slotMinutes) || 60;
  const slots = [];
  for (let t = startMin; t + step <= endMin && slots.length < 48; t += step) {
    slots.push({ startMin: t, label: `${fmt12(t)} – ${fmt12(t + step)}` });
  }
  return slots;
}

/** UTC Date of a slot's start on a given YYYY-MM-DD (IST wall clock). */
export function slotStartUtc(dateIso, startMin) {
  const dayUtcMidnight = new Date(`${dateIso}T00:00:00Z`).getTime();
  return new Date(dayUtcMidnight + (startMin - IST_OFFSET_MIN) * 60000);
}

/**
 * GET /api/bookings/slots/:providerId?date=YYYY-MM-DD
 * Public availability: every slot of that day with free/taken/past flags, so
 * the customer books only genuinely free time and sees when the provider is
 * next available.
 */
router.get('/slots/:providerId', async (req, res, next) => {
  try {
    const dateIso = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
      throw new HttpError(400, 'date must be YYYY-MM-DD');
    }
    const provider = await Shop.findById(req.params.providerId).lean();
    if (!provider) throw new HttpError(404, 'Service provider not found.');

    const cfg = provider.slotConfig || {};
    const day = new Date(`${dateIso}T00:00:00Z`).getUTCDay();
    if ((cfg.daysOff || []).includes(day)) {
      return res.json({ slots: [], dayOff: true, config: cfg });
    }

    const dayStart = new Date(`${dateIso}T00:00:00Z`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
    const taken = await Booking.find({
      provider: provider._id,
      status: { $in: ACTIVE_SLOT_STATUSES },
      requestNow: { $ne: true },
      scheduledDate: { $gte: dayStart, $lt: dayEnd },
    })
      .select('scheduledSlot')
      .lean();
    const takenSet = new Set(taken.map((b) => b.scheduledSlot));

    const now = Date.now();
    const slots = generateSlots(cfg).map((s) => ({
      slot: s.label,
      free: !takenSet.has(s.label),
      past: slotStartUtc(dateIso, s.startMin).getTime() <= now,
    }));
    res.json({ slots, dayOff: false, config: cfg });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const data = validateBody(req, createBookingSchema);

    const provider = await Shop.findById(data.providerId)
      .populate({ path: 'category', populate: { path: 'parent' } })
      .lean();
    if (!provider || provider.isBlocked) {
      throw new HttpError(404, 'Service provider not found.');
    }

    if (data.requestNow) {
      // "Right now" requests only make sense if the provider isn't already on
      // a job. Scheduled slot bookings are exempt — booking tomorrow while the
      // provider works today is exactly what slots are for.
      const activeCount = await Booking.countDocuments({
        provider: provider._id,
        status: { $in: ['accepted', 'scheduled', 'on_the_way', 'in_progress'] },
      });
      if (activeCount > 0) {
        throw new HttpError(409, 'This provider is currently on a job. Please try again later.');
      }
    } else if (data.scheduledDate && data.scheduledSlot) {
      // Slot must still be free (someone may have taken it since the page loaded).
      const dayStart = new Date(`${String(data.scheduledDate).slice(0, 10)}T00:00:00Z`);
      const clash = await Booking.countDocuments({
        provider: provider._id,
        status: { $in: ACTIVE_SLOT_STATUSES },
        scheduledDate: { $gte: dayStart, $lt: new Date(dayStart.getTime() + 24 * 3600 * 1000) },
        scheduledSlot: data.scheduledSlot,
      });
      if (clash > 0) {
        throw new HttpError(409, 'That slot was just booked. Please pick another one.');
      }
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


const rescheduleSchema = z.object({
  scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  scheduledSlot: z.string().min(3).max(60),
});

/**
 * PATCH /api/bookings/:id/reschedule — move a booking to another slot.
 * Allowed for the booking's customer and the provider's owner, while the
 * booking is still requested/accepted/scheduled. Validates the target slot is
 * free, then push-notifies the OTHER party about the change.
 */
router.patch('/:id/reschedule', requireAuth, async (req, res, next) => {
  try {
    const { scheduledDate, scheduledSlot } = validateBody(req, rescheduleSchema);
    const booking = await Booking.findById(req.params.id).populate('provider');
    if (!booking) throw new HttpError(404, 'Booking not found.');

    const isCustomer = String(booking.customer) === String(req.user._id);
    const isProvider =
      booking.provider && String(booking.provider.owner) === String(req.user._id);
    if (!isCustomer && !isProvider) throw new HttpError(403, 'Not your booking.');
    if (!['requested', 'accepted', 'scheduled'].includes(booking.status)) {
      throw new HttpError(409, 'This booking can no longer be rescheduled.');
    }

    const dayStart = new Date(`${scheduledDate}T00:00:00Z`);
    const clash = await Booking.countDocuments({
      _id: { $ne: booking._id },
      provider: booking.provider._id,
      status: { $in: ACTIVE_SLOT_STATUSES },
      scheduledDate: { $gte: dayStart, $lt: new Date(dayStart.getTime() + 24 * 3600 * 1000) },
      scheduledSlot,
    });
    if (clash > 0) throw new HttpError(409, 'That slot is already booked. Pick another.');

    booking.scheduledDate = dayStart;
    booking.scheduledSlot = scheduledSlot;
    booking.requestNow = false;
    booking.reminderSentAt = undefined; // re-arm the 15-min reminder for the new time
    await booking.save();

    // Tell the other side.
    const target = isCustomer ? booking.provider.owner : booking.customer;
    const by = isCustomer ? 'Customer' : booking.provider.name || 'Provider';
    sendPushToUser(target, {
      title: 'Booking time changed',
      body: `${by}: ${booking.serviceName} moved to ${scheduledDate}, ${scheduledSlot}`,
      url: isCustomer ? '/shop' : '/customer/bookings',
      tag: 'booking-reschedule',
    }).catch(() => {});

    res.json({ booking: booking.toObject() });
  } catch (err) {
    next(err);
  }
});

export default router;
