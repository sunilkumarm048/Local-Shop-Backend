import { Booking } from '../models/index.js';
import { sendPushToUser } from './push.js';

/**
 * Slot reminder — the provider's pre-job alarm.
 *
 * Every minute, find accepted/scheduled slot bookings whose start time is
 * within the next 15 minutes and that haven't been reminded yet, and push an
 * alert to the provider's owner. On the native app the push goes through the
 * "order_alerts" FCM channel, so it RINGS with the custom order sound even
 * with the app closed — an alarm in practice.
 *
 * Times: scheduledDate is UTC midnight of the day; scheduledSlot is a label
 * like "9:00 AM – 10:00 AM" in provider-local IST. We parse the first time in
 * the label and convert IST → UTC (single-market assumption, kept explicit).
 */

const IST_OFFSET_MIN = 330;
const REMIND_BEFORE_MIN = 15;
const TICK_MS = 60 * 1000;

/** Parse "9:00 AM" / "09:00" from the start of a slot label → minutes-of-day. */
export function slotLabelStartMinutes(label) {
  const m = String(label || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = (m[3] || '').toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function slotStartUtcMs(scheduledDate, slotLabel) {
  const startMin = slotLabelStartMinutes(slotLabel);
  if (startMin == null || !scheduledDate) return null;
  const dayMidnightUtc = new Date(scheduledDate).setUTCHours(0, 0, 0, 0);
  return dayMidnightUtc + (startMin - IST_OFFSET_MIN) * 60000;
}

async function runTick() {
  const now = Date.now();
  const windowEnd = now + REMIND_BEFORE_MIN * 60 * 1000;

  // Candidate window: today's and (near-midnight edge) yesterday's dates.
  const dayLow = new Date(now - 24 * 3600 * 1000);
  const dayHigh = new Date(windowEnd + 24 * 3600 * 1000);

  const candidates = await Booking.find({
    status: { $in: ['accepted', 'scheduled'] },
    requestNow: { $ne: true },
    reminderSentAt: null,
    scheduledSlot: { $exists: true, $ne: '' },
    scheduledDate: { $gte: dayLow, $lte: dayHigh },
  })
    .populate('provider', 'owner name')
    .populate('customer', 'name')
    .limit(200);

  for (const b of candidates) {
    const startMs = slotStartUtcMs(b.scheduledDate, b.scheduledSlot);
    if (startMs == null) continue;
    if (startMs < now || startMs > windowEnd) continue; // not due yet / already started

    // Mark first (atomically) so two ticks or two instances never double-ring.
    const claimed = await Booking.findOneAndUpdate(
      { _id: b._id, reminderSentAt: null },
      { reminderSentAt: new Date() },
      { new: true }
    );
    if (!claimed || !b.provider?.owner) continue;

    const customerName =
      (typeof b.customer === 'object' && b.customer?.name) || 'Customer';
    const mins = Math.max(1, Math.round((startMs - now) / 60000));
    sendPushToUser(b.provider.owner, {
      title: `⏰ Service in ${mins} min`,
      body: `${b.serviceName} for ${customerName} at ${b.scheduledSlot.split('–')[0].trim()}. Get ready!`,
      url: '/shop',
      tag: `slot-reminder-${b._id}`,
    }).catch(() => {});
  }
}

export function startSlotReminder() {
  setInterval(() => runTick().catch((e) => console.error('[slot-reminder]', e.message)), TICK_MS);
  console.log('[slot-reminder] running (15-min pre-slot alerts, 60s tick)');
}
