import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import {
  registerWithEmail,
  loginWithEmail,
  loginOrCreateWithPhone,
  getCurrentUser,
} from '../services/auth.js';
import { sendOtp, verifyOtp } from '../services/otp.js';
import { requireAuth } from '../middleware/auth.js';
import { validateBody } from '../utils/validate.js';

const router = Router();

// Tighter rate-limit for auth-sensitive endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' },
});

router.use(authLimiter);

// ---------- Email + password ----------

const registerSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  email: z.string().email().toLowerCase(),
  password: z.string().min(8).max(128),
  phone: z.string().trim().optional(),
  role: z.enum(['customer', 'shop', 'delivery']).default('customer'),
});

router.post('/register', async (req, res, next) => {
  try {
    const data = validateBody(req, registerSchema);
    const result = await registerWithEmail(data);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

const loginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1),
});

router.post('/login', async (req, res, next) => {
  try {
    const data = validateBody(req, loginSchema);
    const result = await loginWithEmail(data);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---------- Phone OTP ----------

const sendOtpSchema = z.object({
  phone: z.string().trim().min(10),
});

router.post('/otp/send', async (req, res, next) => {
  try {
    const { phone } = validateBody(req, sendOtpSchema);
    const result = await sendOtp(phone);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

const verifyOtpSchema = z.object({
  phone: z.string().trim().min(10),
  code: z.string().trim().length(6),
  name: z.string().trim().min(1).max(80).optional(),
  roleHint: z.enum(['customer', 'shop', 'delivery']).optional(),
});

router.post('/otp/verify', async (req, res, next) => {
  try {
    const { phone, code, name, roleHint } = validateBody(req, verifyOtpSchema);
    const { phone: normalizedPhone } = await verifyOtp(phone, code);
    const result = await loginOrCreateWithPhone({ phone: normalizedPhone, name, roleHint });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---------- Session ----------

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await getCurrentUser(req.user._id);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// Stateless JWT — logout is mostly a client-side concern. We expose this
// endpoint for symmetry; later we can add a Redis blocklist of revoked tokens
// if we need true server-side invalidation.
router.post('/logout', requireAuth, (_req, res) => {
  res.json({ ok: true });
});

export default router;
