import { Router } from 'express';
import { normalizeSearchQuery } from '../services/search.js';

const router = Router();

/**
 * GET /api/search/normalize?q=...
 *
 * Returns an AI-corrected version of the customer's search query (typos,
 * half-words). Public — no auth needed. Always returns something usable:
 * if AI is unavailable it echoes the raw query back.
 *
 * Response: { original: string, query: string, corrected: boolean }
 */
router.get('/normalize', async (req, res, next) => {
  try {
    const original = String(req.query.q || '').trim();
    if (!original) return res.json({ original: '', query: '', corrected: false });

    const query = await normalizeSearchQuery(original);
    res.json({
      original,
      query,
      corrected: query.toLowerCase() !== original.toLowerCase(),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
