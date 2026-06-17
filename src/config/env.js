import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  CLIENT_ORIGIN: z.string().url().default('http://localhost:3000'),
  MONGODB_URI: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_TEMPLATE_ID: z.string().optional(),
  MSG91_SENDER_ID: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  // Web Push (VAPID). Generate once with: npx web-push generate-vapid-keys
  // Leave unset to disable push cleanly — the app still works, it just won't
  // send browser notifications (in-app socket toasts are unaffected).
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(), // e.g. mailto:you@example.com
  // Email (Resend) for password-reset OTP and notifications. Leave unset to
  // disable email features cleanly. RESEND_FROM must be a verified sender.
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().optional(), // e.g. "Local Shop <noreply@yourdomain.com>"
  // Ola Maps (India geocoding/autocomplete) — server-side key, never exposed
  // to the browser. Leave unset to fall back to OpenStreetMap/Nominatim.
  OLA_MAPS_API_KEY: z.string().optional(),
  // Anthropic (Claude) — used to correct/normalize customer search queries
  // (typos, half-words). Leave unset to fall back to the raw query cleanly.
  ANTHROPIC_API_KEY: z.string().optional(),
  // PHASE 6a: comma-separated allowlist. Any user whose email is in here is
  // auto-granted the 'admin' role on login. The easiest way to bootstrap your
  // first admin without writing a MongoDB script.
  ADMIN_EMAILS: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

/**
 * Parsed admin allowlist (lowercased, deduped). Empty array if ADMIN_EMAILS
 * is unset.
 */
export const ADMIN_EMAILS = (env.ADMIN_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);
