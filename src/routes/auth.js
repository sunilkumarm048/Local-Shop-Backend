import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import {
  registerWithEmail,
  loginWithEmail,
  loginWithGoogle,
  loginOrCreateWithPhone,
  getCurrentUser,
  setOwnPassword,
  updateProfile,
} from '../services/auth.js';
import { sendOtp, verifyOtp } from '../services/otp.js';
import { sendResetOtp, verifyResetOtp } from '../services/emailOtp.js';
import { User } from '../models/index.js';
import { HttpError } from '../middleware/error.js';
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
    console.log('[login] attempt for:', data.email);
    const result = await loginWithEmail(data);
    console.log('[login] SUCCESS for:', data.email, '- token issued, mustChangePassword:', result.user?.mustChangePassword);
    res.json(result);
  } catch (err) {
    console.error('[login] FAILED for', req.body?.email, '-', err.statusCode || '?', err.message);
    next(err);
  }
});

const googleSchema = z.object({ idToken: z.string().min(1) });

router.post('/google', async (req, res, next) => {
  try {
    const data = validateBody(req, googleSchema);
    const result = await loginWithGoogle(data);
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

const addressSchema = z.object({
  label: z.string().trim().max(40).optional(),
  line1: z.string().trim().max(120).optional(),
  line2: z.string().trim().max(120).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  pincode: z.string().trim().max(12).optional(),
  location: z
    .object({ lng: z.number(), lat: z.number() })
    .optional(),
});

const updateProfileSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  avatar: z.string().url().optional().or(z.literal('')),
  addresses: z.array(addressSchema).max(10).optional(),
});

router.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const data = validateBody(req, updateProfileSchema);
    const user = await updateProfile(req.user._id, data);
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

/**
 * POST /api/auth/change-password — set a new password for the logged-in user.
 * Used for the forced first-login change on admin-created shop accounts, and
 * usable any time a user wants to change their password.
 */
router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { newPassword } = validateBody(
      req,
      z.object({ newPassword: z.string().min(6).max(72) })
    );
    await setOwnPassword({ userId: req.user._id, newPassword });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/forgot-password — emails a 6-digit reset code.
 *
 * Always responds 200 with the same message whether or not the email is
 * registered, so attackers can't use it to discover which emails have
 * accounts. The code is only actually sent if a user with that email exists
 * AND email is configured.
 */
router.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = validateBody(
      req,
      z.object({ email: z.string().email() })
    );
    const lower = email.toLowerCase();
    console.log('[forgot-password] request for:', lower);
    const user = await User.findOne({ email: lower });
    console.log('[forgot-password] user found:', Boolean(user));

    let emailDisabled = false;
    if (user) {
      console.log('[forgot-password] calling sendResetOtp...');
      const result = await sendResetOtp(lower);
      console.log('[forgot-password] sendResetOtp result:', JSON.stringify(result));
      if (!result.ok && result.reason === 'email_disabled') emailDisabled = true;
    }

    // If email isn't configured at all, tell the caller plainly (this isn't a
    // user-enumeration leak — it's a server config fact).
    if (emailDisabled) {
      throw new HttpError(503, 'Password reset by email is not available right now.');
    }

    res.json({
      ok: true,
      message: 'If that email is registered, a reset code has been sent.',
    });
  } catch (err) {
    console.error('[forgot-password] error:', err.message);
    next(err);
  }
});

/**
 * POST /api/auth/reset-password — verify the emailed code and set a new
 * password. Consumes the code on success.
 */
router.post('/reset-password', async (req, res, next) => {
  try {
    const { email, code, newPassword } = validateBody(
      req,
      z.object({
        email: z.string().email(),
        code: z.string().min(4).max(8),
        newPassword: z.string().min(6).max(72),
      })
    );
    const lower = email.toLowerCase();

    const check = await verifyResetOtp(lower, code);
    if (!check.ok) {
      const msg =
        check.reason === 'wrong_code'
          ? 'Incorrect code. Please try again.'
          : check.reason === 'too_many_attempts'
            ? 'Too many attempts. Request a new code.'
            : 'Your reset code has expired. Request a new one.';
      throw new HttpError(400, msg);
    }

    const user = await User.findOne({ email: lower });
    if (!user) throw new HttpError(404, 'Account not found');

    await setOwnPassword({ userId: user._id, newPassword });
    res.json({ ok: true, message: 'Password updated. You can now log in.' });
  } catch (err) {
    next(err);
  }
});

export default router;
