import { Router } from 'express';
import health from './health.js';
import auth from './auth.js';
import shops from './shops.js';
import orders from './orders.js';
import payments from './payments.js';
import quotes from './quotes.js';

const router = Router();

router.use('/health', health);
router.use('/auth', auth);
router.use('/shops', shops);
router.use('/orders', orders);
router.use('/payments', payments);
router.use('/quotes', quotes);

// Placeholders for upcoming phases:
//   router.use('/delivery', deliveryRoutes); // Phase 5
//   router.use('/admin', adminRoutes);       // Phase 6

router.get('/', (_req, res) => {
  res.json({ name: 'local-shop-api', version: '0.2.0' });
});

export default router;
