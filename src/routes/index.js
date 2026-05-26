import { Router } from 'express';
import health from './health.js';
import auth from './auth.js';
import shops from './shops.js';
import orders from './orders.js';
import payments from './payments.js';
import quotes from './quotes.js';
import delivery from './delivery.js';
import admin from './admin.js';
import transport from './transport.js';

const router = Router();

router.use('/health', health);
router.use('/auth', auth);
router.use('/shops', shops);
router.use('/orders', orders);
router.use('/payments', payments);
router.use('/quotes', quotes);
router.use('/delivery', delivery);
router.use('/admin', admin);
router.use('/transport', transport);

router.get('/', (_req, res) => {
  res.json({ name: 'local-shop-api', version: '0.12.0' });
});

export default router;
