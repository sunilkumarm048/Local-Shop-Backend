import crypto from 'crypto';

import { redis } from '../config/redis.js';
import { sendOtpEmail } from './email.js';

/**
 * Email OTP for password reset. Same shape as the SMS OTP service: a 6-digit
 * code stored in Redis with a TTL, rate-limited per email, max attempts.
 */

const OTP_TTL_SECONDS = 10 * 60; // 10 min
const RATE_WINDOW_SECONDS = 60 * 60; // 1 hour
const MAX_SENDS_PER_WINDOW = 5;
const MAX_ATTEMPTS = 5;

function genCode() {
  // 6-digit, leading zeros allowed.
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function key(email) {
  return `pwreset:otp:${email.toLowerCase()}`;
}

/**
 * Generate + email a reset code. Rate-limited. Returns { ok } or
 * { ok:false, reason }. Always behaves the same whether or not the email
 * belongs to a real user — the CALLER decides whether to reveal that, to avoid
 * leaking which emails are registered.
 */
export async function sendResetOtp(rawEmail) {
  const email = rawEmail.toLowerCase().trim();

  const rateKey = `pwreset:rate:${email}`;
  const count = await redis.incr(rateKey);
  if (count === 1) await redis.expire(rateKey, RATE_WINDOW_SECONDS);
  if (count > MAX_SENDS_PER_WINDOW) {
    return { ok: false, reason: 'rate_limited' };
  }

  const code = genCode();
  await redis.set(
    key(email),
    JSON.stringify({ code, attempts: 0 }),
    'EX',
    OTP_TTL_SECONDS
  );

  const res = await sendOtpEmail(email, code);
  if (!res.ok) {
    return { ok: false, reason: res.disabled ? 'email_disabled' : 'send_failed' };
  }
  return { ok: true };
}

/**
 * Verify a reset code. Returns { ok } or { ok:false, reason }.
 * On success the code is consumed (deleted).
 */
export async function verifyResetOtp(rawEmail, code) {
  const email = rawEmail.toLowerCase().trim();
  const k = key(email);
  const raw = await redis.get(k);
  if (!raw) return { ok: false, reason: 'expired_or_missing' };

  const payload = JSON.parse(raw);
  if (payload.attempts >= MAX_ATTEMPTS) {
    await redis.del(k);
    return { ok: false, reason: 'too_many_attempts' };
  }

  if (payload.code !== String(code).trim()) {
    payload.attempts += 1;
    const ttl = await redis.ttl(k);
    await redis.set(k, JSON.stringify(payload), 'EX', ttl > 0 ? ttl : OTP_TTL_SECONDS);
    return { ok: false, reason: 'wrong_code' };
  }

  await redis.del(k);
  return { ok: true };
}
