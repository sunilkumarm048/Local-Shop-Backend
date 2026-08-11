import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';

import { Shop } from '../models/index.js';
import { validateBody } from '../utils/validate.js';
import { HttpError } from '../middleware/error.js';
import { createShopOwnerAccount } from '../services/auth.js';
import { sendSignupOtp, verifySignupOtp } from '../services/emailOtp.js';
import { emailShopWelcome } from '../services/email.js';
import { env } from '../config/env.js';

const router = Router();

/**
 * Field-agent onboarding API — /api/agent/*
 *
 * Lets a marketing agent (NOT an admin) register shops/providers on the spot
 * at /agent, protected by a shared access code instead of an account:
 *   - Set AGENT_ACCESS_CODE on the server (Render env).
 *   - The agent enters that code once on the /agent page; every request sends
 *     it in the `x-agent-code` header.
 * No admin panel, no user management, easily rotated by changing the env var
 * (needs redeploy, as always on Render). Every created shop records the
 * agent's name in `onboardedBy` for accountability.
 */
router.use((req, _res, next) => {
  if (!env.AGENT_ACCESS_CODE) {
    return next(new HttpError(503, 'Agent onboarding is not enabled on this server.'));
  }
  const given = String(req.get('x-agent-code') || '');
  // timing-safe compare; length mismatch → definite reject
  const expected = env.AGENT_ACCESS_CODE;
  const ok =
    given.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) {
    return next(new HttpError(401, 'Wrong agent code. Check with the Sarvopakar team.'));
  }
  next();
});

function makeSlug(name) {
  const base =
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'shop';
  return `${base}-${crypto.randomBytes(2).toString('hex')}`;
}

/**
 * Counter verification: the agent sends a 6-digit code to the owner's email
 * DURING registration. The owner reads it from their own phone on the spot —
 * a fake or mistyped email can never complete registration.
 */
const sendOtpSchema = z.object({ email: z.string().email().toLowerCase() });

router.post('/send-email-otp', async (req, res, next) => {
  try {
    const { email } = validateBody(req, sendOtpSchema);
    const sent = await sendSignupOtp(email);
    if (!sent.ok) throw new HttpError(502, 'Could not send the code. Check the email and try again.');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const agentQuickShopSchema = z.object({
  agentName: z.string().min(2).max(60),
  name: z.string().min(2).max(120),
  category: z.string().min(1),
  phone: z.string().min(6).max(20),
  ownerEmail: z.string().email(),
  ownerPassword: z.string().min(6).max(72),
  // 6-digit code the owner received on their email just now (see
  // /send-email-otp). Proves the inbox is real before anything is created.
  emailOtp: z.string().trim().length(6),
  description: z.string().max(500).optional(),
  logo: z.string().url().optional(),
  lat: z.number(),
  lng: z.number(),
  address: z
    .object({
      line1: z.string().max(200).optional(),
      city: z.string().max(100).optional(),
      pincode: z.string().max(12).optional(),
    })
    .optional(),
});

/**
 * POST /api/agent/shops/quick-create — same behavior as the admin version:
 * creates (or reuses) the owner login, lists the shop live immediately, and
 * returns the credentials for the agent to hand to the shopkeeper.
 */
router.post('/shops/quick-create', async (req, res, next) => {
  try {
    const data = validateBody(req, agentQuickShopSchema);

    const otpCheck = await verifySignupOtp(data.ownerEmail.toLowerCase(), data.emailOtp);
    if (!otpCheck.ok) {
      const msg =
        otpCheck.reason === 'expired'
          ? 'The email code expired — tap "Send code" again.'
          : 'Wrong email code. Ask the owner to re-check the email.';
      throw new HttpError(400, msg);
    }

    const { user: owner, reused } = await createShopOwnerAccount({
      email: data.ownerEmail,
      password: data.ownerPassword,
      name: data.name,
      phone: data.phone,
    });
    if (!owner.emailVerified) {
      owner.emailVerified = true; // inbox proven live at the counter via OTP
      await owner.save();
    }

    const shop = await Shop.create({
      name: data.name,
      owner: owner._id,
      ownerEmail: owner.email,
      category: data.category,
      phone: data.phone,
      description: data.description || '',
      logo: data.logo || undefined,
      address: data.address || {},
      location: { type: 'Point', coordinates: [data.lng, data.lat] },
      slug: makeSlug(data.name),
      isApproved: true, // field-onboarded → live immediately
      isOpen: true,
      onboardedBy: data.agentName.trim(),
    });

    // Best-effort welcome email with the credentials (also on the screen).
    emailShopWelcome(owner.email, {
      shopName: shop.name,
      loginEmail: owner.email,
      tempPassword: data.ownerPassword,
      agentName: data.agentName.trim(),
    }).catch(() => {});

    res.status(201).json({
      shop,
      ownerId: owner._id,
      ownerEmail: owner.email,
      reusedExistingAccount: reused,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
