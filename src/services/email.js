import { Resend } from 'resend';

import { env } from '../config/env.js';
import { User } from '../models/index.js';

/**
 * Email sender (Resend). Provider-agnostic surface: the rest of the app only
 * calls sendEmail() — swapping providers later means changing only this file.
 *
 * Disabled gracefully when RESEND_API_KEY is unset: sendEmail() returns
 * { ok:false, disabled:true } instead of throwing, so password-reset routes
 * can surface a clear "email not configured" message rather than crashing.
 */

const emailEnabled = Boolean(env.RESEND_API_KEY && env.RESEND_FROM);
const resend = emailEnabled ? new Resend(env.RESEND_API_KEY) : null;

if (emailEnabled) {
  console.log('[email] Resend configured');
} else {
  console.log('[email] disabled (set RESEND_API_KEY + RESEND_FROM to enable)');
}

export function isEmailEnabled() {
  return emailEnabled;
}

/**
 * Send an email. Never throws — returns a result object so callers stay simple.
 * @param {{to:string, subject:string, html:string, text?:string}} msg
 */
export async function sendEmail({ to, subject, html, text }) {
  if (!emailEnabled) {
    console.log('[email] sendEmail called but email is DISABLED (missing RESEND_API_KEY or RESEND_FROM)');
    return { ok: false, disabled: true };
  }
  console.log('[email] sending to', to, 'via Resend...');
  try {
    const { data, error } = await resend.emails.send({
      from: env.RESEND_FROM,
      to,
      subject,
      html,
      text,
    });
    if (error) {
      console.error('[email] Resend returned error:', JSON.stringify(error));
      return { ok: false, error };
    }
    console.log('[email] Resend success, id:', data?.id);
    return { ok: true, id: data?.id };
  } catch (err) {
    console.error('[email] send threw:', err.message);
    return { ok: false, error: err };
  }
}

/**
 * Convenience: a simple OTP email with consistent branding.
 */
export async function sendVerifyEmail(to, code) {
  return sendEmail({
    to,
    subject: 'Verify your email — Sarvopakar',
    text: `Your Sarvopakar verification code is ${code}. It expires in 10 minutes.`,
    html: `
      <div style="font-family: sans-serif; max-width: 420px; margin: 0 auto;">
        <h2 style="color:#0C831F;">सर्वोपकार · Sarvopakar</h2>
        <p>Welcome! Enter this code to verify your email:</p>
        <p style="font-size: 28px; font-weight: bold; letter-spacing: 4px; color:#111;">${code}</p>
        <p style="color:#666; font-size: 13px;">This code expires in 10 minutes. If you didn't create a Sarvopakar account, you can safely ignore this email.</p>
      </div>
    `,
  });
}

export async function sendOtpEmail(to, code) {
  return sendEmail({
    to,
    subject: 'Your Sarvopakar password reset code',
    text: `Your password reset code is ${code}. It expires in 10 minutes. If you didn't request this, ignore this email.`,
    html: `
      <div style="font-family: sans-serif; max-width: 420px; margin: 0 auto;">
        <h2 style="color:#0C831F;">सर्वोपकार · Sarvopakar</h2>
        <p>Your password reset code is:</p>
        <p style="font-size: 28px; font-weight: bold; letter-spacing: 4px; color:#111;">${code}</p>
        <p style="color:#666; font-size: 13px;">This code expires in 10 minutes. If you didn't request a password reset, you can safely ignore this email.</p>
      </div>
    `,
  });
}

/* =========================================================================
 * Notification emails (Sarvopakar). All best-effort: they look up the user's
 * email and send via Resend. If the user has no email on file, they no-op.
 * ======================================================================= */

const SITE_URL = env.CLIENT_ORIGIN || 'https://www.sarvopakar.com';

/** Shared branded wrapper so every notification email looks consistent. */
function wrap(bodyHtml) {
  return `
    <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 480px; margin: 0 auto; border: 1px solid #eee; border-radius: 12px; overflow: hidden;">
      <div style="background:#F8CD46; padding: 18px 22px; text-align:center;">
        <div style="font-size:13px; font-weight:700; color:#7a5c00; letter-spacing:1px;">SARVOPAKAR</div>
        <div style="font-size:24px; font-weight:700; color:#1a1a1a;">सर्वोपकार</div>
      </div>
      <div style="padding: 22px;">
        ${bodyHtml}
      </div>
      <div style="padding: 14px 22px; background:#fafafa; color:#999; font-size:11px; text-align:center;">
        Sarvopakar — your neighbourhood, delivered &amp; served.
      </div>
    </div>
  `;
}

/** Look up a user's email by id and send. Returns silently if none. */
export async function sendEmailToUser(userId, { subject, html, text }) {
  if (!userId) return { ok: false, skipped: 'no-user' };
  try {
    const user = await User.findById(userId).select('email').lean();
    if (!user?.email) return { ok: false, skipped: 'no-email' };
    return await sendEmail({ to: user.email, subject, html, text });
  } catch (err) {
    console.error('[email] sendEmailToUser failed:', err.message);
    return { ok: false, error: err };
  }
}

/** New service booking → notify the provider. */
export async function emailNewBooking(ownerId, { serviceName, customerName, when, address }) {
  const html = wrap(`
    <h2 style="margin:0 0 10px; font-size:19px; color:#0C831F;">New service request</h2>
    <p style="margin:0 0 14px; color:#333;">You have a new booking request on Sarvopakar.</p>
    <table style="width:100%; font-size:14px; color:#333;">
      <tr><td style="padding:4px 0; color:#888;">Service</td><td style="padding:4px 0; font-weight:600;">${serviceName || '-'}</td></tr>
      <tr><td style="padding:4px 0; color:#888;">Customer</td><td style="padding:4px 0;">${customerName || '-'}</td></tr>
      <tr><td style="padding:4px 0; color:#888;">When</td><td style="padding:4px 0;">${when || 'As soon as possible'}</td></tr>
      ${address ? `<tr><td style="padding:4px 0; color:#888;">Where</td><td style="padding:4px 0;">${address}</td></tr>` : ''}
    </table>
    <a href="${SITE_URL}/shop" style="display:inline-block; margin-top:18px; background:#0C831F; color:#fff; text-decoration:none; padding:10px 20px; border-radius:8px; font-weight:600;">View &amp; accept</a>
  `);
  return sendEmailToUser(ownerId, {
    subject: 'New service request — Sarvopakar',
    text: `New service request: ${serviceName || ''} from ${customerName || 'a customer'}. Open ${SITE_URL}/shop to accept.`,
    html,
  });
}

/** Booking status change → notify the customer. */
export async function emailBookingStatus(customerId, { serviceName, status, providerName }) {
  const nice = String(status || '').replace(/_/g, ' ');
  const html = wrap(`
    <h2 style="margin:0 0 10px; font-size:19px; color:#0C831F;">Booking update</h2>
    <p style="margin:0 0 14px; color:#333;">Your ${serviceName || 'service'} booking${providerName ? ` with <b>${providerName}</b>` : ''} is now:</p>
    <p style="font-size:22px; font-weight:700; color:#1a1a1a; text-transform:capitalize; margin:0 0 18px;">${nice}</p>
    <a href="${SITE_URL}/customer/bookings" style="display:inline-block; background:#0C831F; color:#fff; text-decoration:none; padding:10px 20px; border-radius:8px; font-weight:600;">Track booking</a>
  `);
  return sendEmailToUser(customerId, {
    subject: `Booking ${nice} — Sarvopakar`,
    text: `Your ${serviceName || 'service'} booking is now ${nice}. Track it at ${SITE_URL}/customer/bookings`,
    html,
  });
}

/** New product order → notify the shop owner. */
export async function emailNewOrder(ownerId, { orderCode, itemCount, total, customerName }) {
  const html = wrap(`
    <h2 style="margin:0 0 10px; font-size:19px; color:#0C831F;">New order received</h2>
    <p style="margin:0 0 14px; color:#333;">You have a new order on Sarvopakar.</p>
    <table style="width:100%; font-size:14px; color:#333;">
      ${orderCode ? `<tr><td style="padding:4px 0; color:#888;">Order</td><td style="padding:4px 0; font-weight:600;">#${orderCode}</td></tr>` : ''}
      <tr><td style="padding:4px 0; color:#888;">Items</td><td style="padding:4px 0;">${itemCount ?? '-'}</td></tr>
      ${total != null ? `<tr><td style="padding:4px 0; color:#888;">Total</td><td style="padding:4px 0; font-weight:600;">₹${total}</td></tr>` : ''}
      ${customerName ? `<tr><td style="padding:4px 0; color:#888;">Customer</td><td style="padding:4px 0;">${customerName}</td></tr>` : ''}
    </table>
    <a href="${SITE_URL}/shop" style="display:inline-block; margin-top:18px; background:#0C831F; color:#fff; text-decoration:none; padding:10px 20px; border-radius:8px; font-weight:600;">View order</a>
  `);
  return sendEmailToUser(ownerId, {
    subject: 'New order received — Sarvopakar',
    text: `New order${orderCode ? ` #${orderCode}` : ''}: ${itemCount ?? ''} items${total != null ? `, ₹${total}` : ''}. View at ${SITE_URL}/shop`,
    html,
  });
}

/**
 * Welcome email for a field-onboarded shop owner: their login + temp password
 * and what to do next. Sent by the agent/admin quick-create flows.
 */
export async function emailShopWelcome(to, { shopName, loginEmail, tempPassword, agentName }) {
  const subject = `Welcome to Sarvopakar — ${shopName} is registered 🎉`;
  const html = `
    <div style="font-family:sans-serif;max-width:540px;margin:0 auto">
      <div style="background:#F7C736;border-radius:12px 12px 0 0;padding:18px 22px">
        <h2 style="margin:0;color:#171200">सर्वोपकार · Sarvopakar</h2>
      </div>
      <div style="border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;padding:22px">
        <h3 style="color:#128A46;margin-top:0">Welcome! ${shopName} is registered 🎉</h3>
        <p>${agentName ? `Registered at your shop by our team member <b>${agentName}</b>.` : 'Your business is now registered on Sarvopakar.'}</p>

        <p style="background:#E7F5EC;border:1px solid #128A46;border-radius:8px;padding:12px;margin:14px 0">
          <b>Status:</b> Under review ✅<br/>
          <span style="color:#444;font-size:14px">Our team verifies new registrations — your page usually goes
          <b>live the same day</b>. Customers will then find you on the map and can book you online.</span>
        </p>

        <p style="background:#FFF8E6;border:1px solid #F2B90D;border-radius:8px;padding:12px;margin:14px 0">
          <b>Your login</b><br/>
          Email: <b>${loginEmail}</b> <span style="color:#128A46">(verified ✓)</span><br/>
          Temporary password: <b>${tempPassword}</b><br/>
          <span style="color:#666;font-size:13px">On first sign-in you'll set your own password. Keep this email safe until then.</span>
        </p>

        <p><b>Get started in 3 steps:</b></p>
        <ol style="padding-left:20px;line-height:1.7;margin-top:6px">
          <li>Sign in at <a href="https://www.sarvopakar.com/login">www.sarvopakar.com/login</a> and set your password</li>
          <li>Install the <a href="https://www.sarvopakar.com/sarvopakar-provider.apk"><b>Sarvopakar Partner app</b></a> — your phone rings loudly for every booking</li>
          <li>In the app, open <b>My time slots</b> — set your working hours and weekly off</li>
        </ol>

        <p style="color:#666;font-size:13px;margin-bottom:0">
          Questions? ${agentName ? `Contact ${agentName} or ` : ''}visit
          <a href="https://www.sarvopakar.com">www.sarvopakar.com</a>.<br/>
          Sarvopakar — supporting local businesses. 0% commission.
        </p>
      </div>
    </div>`;
  const text =
    `Welcome to Sarvopakar! ${shopName} is registered` +
    (agentName ? ` by our team member ${agentName}` : '') +
    `. Status: under review — usually live the same day. ` +
    `Login: ${loginEmail} (verified) / Temporary password: ${tempPassword}. ` +
    `Steps: 1) Sign in at https://www.sarvopakar.com/login and set your password. ` +
    `2) Install the Partner app: https://www.sarvopakar.com/sarvopakar-provider.apk ` +
    `3) Set your time slots in the app. Sarvopakar — 0% commission.`;
  return sendEmail({ to, subject, html, text });
}


/** Sent when the admin approves a pending shop — the go-live moment. */
export async function emailShopApproved(to, { shopName }) {
  return sendEmail({
    to,
    subject: `${shopName} is now LIVE on Sarvopakar 🎉`,
    text: `Good news! ${shopName} has been approved and is now live on Sarvopakar. Customers near you can find you and book right away. Sign in at https://www.sarvopakar.com/login to manage bookings, timings and your page.`,
    html: `
      <div style="font-family: sans-serif; max-width: 440px; margin: 0 auto;">
        <h2 style="color:#0C831F;">सर्वोपकार · Sarvopakar</h2>
        <p style="font-size:16px;"><b>${shopName}</b> is approved and <b style="color:#0C831F;">LIVE</b> 🎉</p>
        <p>Customers near you can now find you and book right away.</p>
        <p>
          <a href="https://www.sarvopakar.com/login"
             style="display:inline-block;background:#0C831F;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold;">
            Open my dashboard
          </a>
        </p>
        <p style="color:#666;font-size:13px;">Tip: open "My time slots" once to set your working hours and days off.</p>
      </div>
    `,
  });
}
