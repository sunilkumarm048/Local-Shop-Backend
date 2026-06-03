import crypto from 'crypto';

import { PasswordResetCode } from '../models/index.js';
import { sendOtpEmail } from './email.js';

/**
 * Email OTP for password reset — backed by MongoDB (NOT Redis).
 *
 * Redis on the current host is unstable (ECONNRESET), and a flaky cache must
 * never block password resets, so reset codes live in MongoDB with a TTL index
 * that auto-expires them. Same exported API as before, so the routes are
 * unchanged.
 */

const OTP_TTL_MS = 10 * 60 * 1000; // 10 min
const MAX_ATTEMPTS = 5;

function genCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Generate + email a reset code (upsert: one active code per email).
 * Returns { ok } or { ok:false, reason }.
 */
export async function sendResetOtp(rawEmail) {
  const email = rawEmail.toLowerCase().trim();
  const code = genCode();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await PasswordResetCode.findOneAndUpdate(
    { email },
    { $set: { code, attempts: 0, expiresAt } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const res = await sendOtpEmail(email, code);
  if (!res.ok) {
    return { ok: false, reason: res.disabled ? 'email_disabled' : 'send_failed' };
  }
  return { ok: true };
}

/**
 * Verify a reset code. Returns { ok } or { ok:false, reason }.
 * Consumes the code on success.
 */
export async function verifyResetOtp(rawEmail, code) {
  const email = rawEmail.toLowerCase().trim();
  const doc = await PasswordResetCode.findOne({ email });

  if (!doc || doc.expiresAt < new Date()) {
    return { ok: false, reason: 'expired_or_missing' };
  }
  if (doc.attempts >= MAX_ATTEMPTS) {
    await PasswordResetCode.deleteOne({ _id: doc._id });
    return { ok: false, reason: 'too_many_attempts' };
  }
  if (doc.code !== String(code).trim()) {
    doc.attempts += 1;
    await doc.save();
    return { ok: false, reason: 'wrong_code' };
  }

  await PasswordResetCode.deleteOne({ _id: doc._id });
  return { ok: true };
}
