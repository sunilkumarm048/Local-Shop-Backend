import { Resend } from 'resend';

import { env } from '../config/env.js';

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
export async function sendOtpEmail(to, code) {
  return sendEmail({
    to,
    subject: 'Your Local Shop password reset code',
    text: `Your password reset code is ${code}. It expires in 10 minutes. If you didn't request this, ignore this email.`,
    html: `
      <div style="font-family: sans-serif; max-width: 420px; margin: 0 auto;">
        <h2 style="color:#3B6D11;">Local Shop</h2>
        <p>Your password reset code is:</p>
        <p style="font-size: 28px; font-weight: bold; letter-spacing: 4px; color:#111;">${code}</p>
        <p style="color:#666; font-size: 13px;">This code expires in 10 minutes. If you didn't request a password reset, you can safely ignore this email.</p>
      </div>
    `,
  });
}
