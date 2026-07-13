import { Router } from 'express';
import { AppConfig } from '../models/index.js';

const router = Router();

/**
 * GET /api/config — public feature flags for the frontend.
 * No auth: customers read this on the home page. Writes happen only
 * through the admin-guarded PATCH /api/admin/config.
 */
router.get('/', async (_req, res, next) => {
  try {
    const cfg = await AppConfig.getCurrent();
    res.json({ flags: cfg.flags });
  } catch (err) {
    next(err);
  }
});

export default router;
