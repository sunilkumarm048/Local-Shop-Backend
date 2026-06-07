import { Router } from 'express';
import { z } from 'zod';

import { QrCode, Shop } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/role.js';
import { validateBody } from '../utils/validate.js';
import { HttpError } from '../middleware/error.js';

/**
 * QR-flyer system.
 *
 * Printed flyers all share one design; each carries a unique short `code`
 * (e.g. "0001") and its QR encodes  <FRONTEND>/q/<code>.  The frontend /q/[code]
 * page calls the PUBLIC resolve endpoint here to find which shop the code is
 * linked to, then redirects there.
 *
 * Admin pre-generates a batch of blank codes, then links each to a shop after
 * the shop is registered + approved.
 *
 *   PUBLIC:
 *     GET  /api/qr/:code/resolve      -> { status, shopId? }  (+ counts a scan)
 *
 *   ADMIN (role 'admin'):
 *     POST /api/qr/admin/generate     { count } -> creates N new blank codes
 *     GET  /api/qr/admin/list         ?status=all|linked|blank -> codes
 *     POST /api/qr/admin/:code/link   { shopId } -> link code to a shop
 *     POST /api/qr/admin/:code/unlink            -> make code blank again
 */

const router = Router();

/* --------------------------- PUBLIC: resolve a scan --------------------------- */
router.get('/:code/resolve', async (req, res, next) => {
  try {
    const code = String(req.params.code || '').trim();
    if (!code) return res.status(400).json({ status: 'invalid' });

    const qr = await QrCode.findOne({ code });
    if (!qr) return res.status(404).json({ status: 'unknown' });

    // Count the scan (fire-and-forget; don't block the redirect on it).
    QrCode.updateOne(
      { _id: qr._id },
      { $inc: { scans: 1 }, $set: { lastScannedAt: new Date() } }
    ).catch(() => {});

    if (!qr.shop) {
      return res.json({ status: 'blank' });
    }

    // Make sure the linked shop still exists + is live.
    const shop = await Shop.findById(qr.shop).select('_id isApproved');
    if (!shop) return res.json({ status: 'blank' });

    return res.json({
      status: 'linked',
      shopId: String(shop._id),
      approved: Boolean(shop.isApproved),
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------- ADMIN routes ------------------------------- */
router.use('/admin', requireAuth, requireRole('admin'));

// Zero-pad a number to at least 4 digits: 1 -> "0001", 1234 -> "1234".
function pad(n) {
  return String(n).padStart(4, '0');
}

/**
 * Generate a batch of new blank codes. Codes continue numbering from the
 * highest existing numeric code, so repeated batches never collide.
 *   body: { count: number }  (1..2000 per call)
 */
router.post('/admin/generate', async (req, res, next) => {
  try {
    const { count } = validateBody(
      req,
      z.object({ count: z.coerce.number().int().min(1).max(2000) })
    );

    // Find the current highest numeric code to continue the sequence.
    const all = await QrCode.find({}).select('code').lean();
    let maxNum = 0;
    for (const c of all) {
      const n = parseInt(c.code, 10);
      if (!Number.isNaN(n) && n > maxNum) maxNum = n;
    }

    const docs = [];
    for (let i = 1; i <= count; i++) {
      docs.push({ code: pad(maxNum + i) });
    }
    await QrCode.insertMany(docs, { ordered: false });

    const created = docs.map((d) => d.code);
    res.status(201).json({
      created: created.length,
      from: created[0],
      to: created[created.length - 1],
      codes: created,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * List codes. ?status=all|linked|blank  (default all). Newest first.
 * Returns the linked shop's name for convenience.
 */
router.get('/admin/list', async (req, res, next) => {
  try {
    const status = String(req.query.status || 'all');
    const filter =
      status === 'linked'
        ? { shop: { $ne: null } }
        : status === 'blank'
          ? { shop: null }
          : {};

    const codes = await QrCode.find(filter)
      .sort({ code: 1 })
      .populate('shop', 'name')
      .lean();

    res.json({
      total: codes.length,
      linked: codes.filter((c) => c.shop).length,
      blank: codes.filter((c) => !c.shop).length,
      codes: codes.map((c) => ({
        code: c.code,
        shopId: c.shop?._id ? String(c.shop._id) : null,
        shopName: c.shop?.name || null,
        scans: c.scans || 0,
        note: c.note || '',
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Link a code to a shop.  body: { shopId, note? }
 */
router.post('/admin/:code/link', async (req, res, next) => {
  try {
    const { shopId, note } = validateBody(
      req,
      z.object({ shopId: z.string().min(1), note: z.string().max(200).optional() })
    );
    const code = String(req.params.code || '').trim();

    const shop = await Shop.findById(shopId).select('_id name');
    if (!shop) throw new HttpError(404, 'Shop not found');

    const qr = await QrCode.findOneAndUpdate(
      { code },
      { $set: { shop: shop._id, note: note || '' } },
      { new: true }
    );
    if (!qr) throw new HttpError(404, 'QR code not found');

    res.json({ code: qr.code, shopId: String(shop._id), shopName: shop.name });
  } catch (err) {
    next(err);
  }
});

/**
 * Unlink a code (make it blank again).
 */
router.post('/admin/:code/unlink', async (req, res, next) => {
  try {
    const code = String(req.params.code || '').trim();
    const qr = await QrCode.findOneAndUpdate(
      { code },
      { $set: { shop: null, note: '' } },
      { new: true }
    );
    if (!qr) throw new HttpError(404, 'QR code not found');
    res.json({ code: qr.code, status: 'blank' });
  } catch (err) {
    next(err);
  }
});

export default router;
