import { Router } from 'express';
import { z } from 'zod';

import { Shop, Review, Order, Category } from '../models/index.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { validateBody } from '../utils/validate.js';
import { HttpError } from '../middleware/error.js';

const router = Router();

// ---------- helpers ----------

/**
 * Recompute and persist a shop's aggregate rating + count from its reviews.
 * Called after every create / edit / delete so the denormalized fields on
 * Shop (read by the customer cards and nearby lists) stay accurate.
 */
async function recomputeShopRating(shopId) {
  const agg = await Review.aggregate([
    { $match: { shop: shopId } },
    {
      $group: {
        _id: '$shop',
        avg: { $avg: '$rating' },
        count: { $sum: 1 },
      },
    },
  ]);

  const { avg = 0, count = 0 } = agg[0] || {};
  await Shop.updateOne(
    { _id: shopId },
    {
      $set: {
        // One decimal place, matches the UI (e.g. 4.5).
        rating: Math.round(avg * 10) / 10,
        ratingCount: count,
      },
    }
  );
}

/**
 * Is this shop a "service" shop? A shop is a service if its category's
 * top-level parent group is named "Services". Walks one level up because the
 * data model only nests one level deep.
 *
 * Returns false if the shop has no category (treated as a product shop, the
 * stricter path — they'll need a delivered order to review).
 */
async function isServiceShop(shop) {
  if (!shop.category) return false;
  const cat = await Category.findById(shop.category).lean();
  if (!cat) return false;
  // If the category itself is top-level, check its own name; otherwise look
  // up the parent group's name.
  if (!cat.parent) return /service/i.test(cat.name);
  const parent = await Category.findById(cat.parent).lean();
  return parent ? /service/i.test(parent.name) : false;
}

/**
 * Throw 403 unless the caller is allowed to review this shop.
 *   - service shop: any logged-in customer may review
 *   - product shop: caller must have at least one delivered order from it
 */
async function assertCanReview(userId, shop) {
  if (await isServiceShop(shop)) return;

  const delivered = await Order.exists({
    customer: userId,
    shop: shop._id,
    status: 'delivered',
  });
  if (!delivered) {
    throw new HttpError(
      403,
      'You can review this shop only after a delivered order.'
    );
  }
}

// ============================================================
// PUBLIC — list reviews for a shop
// ============================================================

/**
 * GET /api/shops/:id/reviews
 *   ?limit= (default 20, max 50)  ?skip= (pagination)
 *
 * Returns reviews newest-first plus a summary. If the caller is logged in,
 * `mine` carries their own review (or null) so the UI can prefill the edit
 * form without a second request.
 */
router.get('/:id/reviews', optionalAuth, async (req, res, next) => {
  try {
    const shopId = req.params.id;
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const skip = Number(req.query.skip) || 0;

    const [reviews, total] = await Promise.all([
      Review.find({ shop: shopId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .skip(skip)
        .lean(),
      Review.countDocuments({ shop: shopId }),
    ]);

    let mine = null;
    if (req.user) {
      mine = await Review.findOne({
        shop: shopId,
        customer: req.user._id,
      }).lean();
    }

    res.json({ reviews, total, mine });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// CUSTOMER — create / update (upsert) own review
// ============================================================

const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(1000).optional().or(z.literal('')),
  photos: z.array(z.string().url()).max(6).optional(),
});

/**
 * PUT /api/shops/:id/reviews — create or edit the caller's review.
 *
 * Upsert on (shop, customer): one review per customer per shop, editable.
 * Eligibility enforced by assertCanReview. Recomputes the shop's aggregate
 * rating afterwards.
 */
router.put('/:id/reviews', requireAuth, async (req, res, next) => {
  try {
    const data = validateBody(req, reviewSchema);
    const shop = await Shop.findById(req.params.id);
    if (!shop || shop.isBlocked) throw new HttpError(404, 'Shop not found');

    await assertCanReview(req.user._id, shop);

    const review = await Review.findOneAndUpdate(
      { shop: shop._id, customer: req.user._id },
      {
        $set: {
          rating: data.rating,
          comment: data.comment || '',
          photos: data.photos || [],
          customerName: req.user.name || 'Customer',
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    await recomputeShopRating(shop._id);

    res.status(201).json({ review });
  } catch (err) {
    // Duplicate-key (race on first insert) — retry as a plain update.
    if (err?.code === 11000) {
      try {
        const data = reviewSchema.parse(req.body);
        const review = await Review.findOneAndUpdate(
          { shop: req.params.id, customer: req.user._id },
          {
            $set: {
              rating: data.rating,
              comment: data.comment || '',
              photos: data.photos || [],
            },
          },
          { new: true }
        );
        await recomputeShopRating(review.shop);
        return res.status(200).json({ review });
      } catch (e2) {
        return next(e2);
      }
    }
    next(err);
  }
});

/**
 * DELETE /api/shops/:id/reviews — remove the caller's own review.
 */
router.delete('/:id/reviews', requireAuth, async (req, res, next) => {
  try {
    const result = await Review.findOneAndDelete({
      shop: req.params.id,
      customer: req.user._id,
    });
    if (!result) throw new HttpError(404, 'You have no review on this shop');
    await recomputeShopRating(result.shop);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/shops/:id/reviews/can — does the caller meet the eligibility bar?
 * Lets the customer UI show or hide the "Write a review" button without
 * attempting a write. Returns { canReview, reason }.
 */
router.get('/:id/reviews/can', requireAuth, async (req, res, next) => {
  try {
    const shop = await Shop.findById(req.params.id).lean();
    if (!shop || shop.isBlocked) throw new HttpError(404, 'Shop not found');

    if (await isServiceShop(shop)) {
      return res.json({ canReview: true, reason: 'service' });
    }
    const delivered = await Order.exists({
      customer: req.user._id,
      shop: shop._id,
      status: 'delivered',
    });
    res.json({
      canReview: Boolean(delivered),
      reason: delivered ? 'ordered' : 'no_delivered_order',
    });
  } catch (err) {
    next(err);
  }
});

export default router;
