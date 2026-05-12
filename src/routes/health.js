import { Router } from 'express';
import mongoose from 'mongoose';
import { redis } from '../config/redis.js';

const router = Router();

router.get('/', async (_req, res) => {
  const mongoOk = mongoose.connection.readyState === 1;
  let redisOk = false;
  try {
    redisOk = (await redis.ping()) === 'PONG';
  } catch {
    /* redisOk stays false */
  }
  res.json({
    status: mongoOk && redisOk ? 'ok' : 'degraded',
    mongo: mongoOk,
    redis: redisOk,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

export default router;
