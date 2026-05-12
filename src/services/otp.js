import crypto from 'node:crypto';
import { redis } from '../config/redis.js';
import { HttpError } from '../middleware/error.js';

/**
 * OTP service.
 *
 * Provider-agnostic: the only thing that's mock-specific is `sendSms()` at
 * the bottom. To switch to MSG91 / Twilio / Firebase later, replace that
 * function — everything else (generation, storage, verification, rate-limits)
 * stays the same.
 *
 * Redis keys:
 *   otp:<phone>          stringified { hash, expiresAt, attempts }
 *   otp:rate:<phone>     count of sends in current window (TTL = 1 hour)
 */

const OTP_TTL_SECONDS = 5 * 60;          // OTP valid for 5 minutes
const MAX_ATTEMPTS = 5;                   // verification attempts per OTP
const MAX_SENDS_PER_HOUR = 5;             // limit OTPs per phone per hour
const RATE_WINDOW_SECONDS = 60 * 60;

function generateCode() {
  // 6-digit numeric, leading zeros allowed
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function normalizePhone(phone) {
  // Strip everything non-digit, then assume Indian +91 if 10 digits given
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (digits.length === 13 && digits.startsWith('091')) return `+${digits.slice(1)}`;
  if (digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  throw new HttpError(400, 'Invalid phone number');
}

export async function sendOtp(rawPhone) {
  const phone = normalizePhone(rawPhone);

  // Rate-limit
  const rateKey = `otp:rate:${phone}`;
  const count = await redis.incr(rateKey);
  if (count === 1) await redis.expire(rateKey, RATE_WINDOW_SECONDS);
  if (count > MAX_SENDS_PER_HOUR) {
    throw new HttpError(429, 'Too many OTP requests. Try again in an hour.');
  }

  const code = generateCode();
  const payload = {
    hash: hashCode(code),
    expiresAt: Date.now() + OTP_TTL_SECONDS * 1000,
    attempts: 0,
  };

  await redis.set(`otp:${phone}`, JSON.stringify(payload), 'EX', OTP_TTL_SECONDS);

  await sendSms(phone, code);

  return { phone, expiresInSeconds: OTP_TTL_SECONDS };
}

export async function verifyOtp(rawPhone, code) {
  const phone = normalizePhone(rawPhone);
  const key = `otp:${phone}`;

  const raw = await redis.get(key);
  if (!raw) throw new HttpError(400, 'OTP expired or not requested');

  const payload = JSON.parse(raw);

  if (payload.attempts >= MAX_ATTEMPTS) {
    await redis.del(key);
    throw new HttpError(429, 'Too many incorrect attempts. Request a new OTP.');
  }

  if (Date.now() > payload.expiresAt) {
    await redis.del(key);
    throw new HttpError(400, 'OTP expired');
  }

  if (hashCode(String(code || '')) !== payload.hash) {
    payload.attempts += 1;
    const remainingTtl = Math.max(1, Math.ceil((payload.expiresAt - Date.now()) / 1000));
    await redis.set(key, JSON.stringify(payload), 'EX', remainingTtl);
    throw new HttpError(400, 'Invalid OTP');
  }

  // Success — invalidate so the same code can't be reused
  await redis.del(key);
  return { phone };
}

/**
 * Mock SMS sender. Logs the code to the server console.
 * To switch providers:
 *   - MSG91:    POST https://control.msg91.com/api/v5/otp + their template
 *   - Twilio:   twilio.verify.v2.services(SID).verifications.create(...)
 * Both follow the same `(phone, code) => Promise<void>` shape.
 */
async function sendSms(phone, code) {
  // eslint-disable-next-line no-console
  console.log(`\n  [otp] To: ${phone}\n  [otp] Code: ${code}\n  [otp] (mock provider — replace sendSms() in src/services/otp.js for production)\n`);
}
