import { Router } from 'express';

import { ProductTemplate } from '../models/index.js';
import { optionalAuth } from '../middleware/auth.js';

const router = Router();

/**
 * GET /api/templates — list product templates.
 *
 * Query params (all optional):
 *   - group: string  → filter by UI group ("Grains", "Pulses", ...)
 *   - q: string      → text search on name
 *   - category: ObjectId  → filter by category
 *
 * Returns active templates only. Sorted by group then sortOrder.
 * No auth required to read (templates are a public catalog).
 *
 * The total set is small (~120 docs) so we don't paginate yet.
 */
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const filter = { isActive: true };
    if (req.query.group) filter.group = String(req.query.group);
    if (req.query.category) filter.category = String(req.query.category);
    if (req.query.q) {
      const q = String(req.query.q).trim();
      if (q) filter.name = { $regex: q, $options: 'i' };
    }
    const templates = await ProductTemplate.find(filter)
      .sort({ group: 1, sortOrder: 1, name: 1 })
      .lean();

    // Group counts — useful for the UI's group tab strip.
    const groupCounts = {};
    for (const t of templates) {
      groupCounts[t.group] = (groupCounts[t.group] || 0) + 1;
    }

    res.json({ templates, groupCounts });
  } catch (err) {
    next(err);
  }
});

export default router;
