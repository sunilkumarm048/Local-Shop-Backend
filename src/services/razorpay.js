import Razorpay from 'razorpay';
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/error.js';

/**
 * Razorpay integration.
 *
 * Two responsibilities:
 *   1. Create a Razorpay order for a given amount (server-signed).
 *   2. Verify the payment signature when the client returns from the modal.
 *
 * The webhook handler in routes/payments.js handles async payment events
 * (refunds, late captures, failures).
 *
 * Why server-only? The amount is signed by `RAZORPAY_KEY_SECRET`. If we
 * created the Razorpay order from the client, a user could tamper with the
 * amount in DevTools and pay less than they should.
 */

let cachedClient = null;
function getClient() {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw new HttpError(503, 'Payment provider not configured');
  }
  if (!cachedClient) {
    cachedClient = new Razorpay({
      key_id: env.RAZORPAY_KEY_ID,
      key_secret: env.RAZORPAY_KEY_SECRET,
    });
  }
  return cachedClient;
}

/**
 * Create a Razorpay order. `amountInr` is rupees; Razorpay wants paise.
 */
export async function createRazorpayOrder({ amountInr, receipt, notes = {} }) {
  const client = getClient();
  const order = await client.orders.create({
    amount: Math.round(amountInr * 100),
    currency: 'INR',
    receipt: receipt?.slice(0, 40), // Razorpay caps receipt at 40 chars
    notes,
  });
  return order; // { id, amount, currency, status, ... }
}

/**
 * Verify the signature returned from the checkout modal.
 * Razorpay docs: signature = HMAC_SHA256(orderId + "|" + paymentId, KEY_SECRET).
 */
export function verifyPaymentSignature({ orderId, paymentId, signature }) {
  if (!env.RAZORPAY_KEY_SECRET) {
    throw new HttpError(503, 'Payment provider not configured');
  }
  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return expected === signature;
}

/**
 * Verify a webhook payload using `RAZORPAY_WEBHOOK_SECRET`.
 * `rawBody` must be the original buffer/string — JSON-parsing it first changes
 * whitespace and breaks the signature, which is why webhook routes use
 * `express.raw()` instead of `express.json()`.
 */
export function verifyWebhookSignature({ rawBody, signature }) {
  if (!env.RAZORPAY_WEBHOOK_SECRET) return false;
  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  return expected === signature;
}
