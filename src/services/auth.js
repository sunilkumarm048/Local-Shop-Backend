import bcrypt from 'bcryptjs';
import { User, DeliveryProfile } from '../models/index.js';
import { signToken } from '../utils/jwt.js';
import { HttpError } from '../middleware/error.js';
import { ADMIN_EMAILS, env } from '../config/env.js';

const ALLOWED_SIGNUP_ROLES = ['customer', 'shop', 'delivery'];

/**
 * Hash a plaintext password. Cost factor 10 is plenty for an API tier —
 * higher costs add latency without meaningful security gain at this scale.
 */
async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

/**
 * Issue a JWT for a user. `sub` is the canonical user id.
 * `roles` is included so Socket.IO middleware can authorize without a DB lookup.
 */
function issueToken(user) {
  return signToken({
    sub: user._id.toString(),
    roles: user.roles,
  });
}

/**
 * Strip sensitive fields before returning a user to the client.
 */
function toPublic(user) {
  const obj = user.toObject ? user.toObject() : user;
  delete obj.passwordHash;
  obj.id = obj._id.toString();
  delete obj._id;
  delete obj.__v;
  return obj;
}

/**
 * PHASE 6a — env-driven admin bootstrap.
 *
 * If the user's email is in the ADMIN_EMAILS allowlist and they don't yet
 * have the 'admin' role, add it. Idempotent — fine to call on every login.
 *
 * We mutate the in-memory `user` doc so the JWT issued right after this call
 * already carries the admin role, no second login required.
 */
async function maybePromoteAdmin(user) {
  if (!user.email) return;
  if (!ADMIN_EMAILS.includes(user.email.toLowerCase())) return;
  if (user.roles.includes('admin')) return;
  user.roles.push('admin');
  await User.updateOne({ _id: user._id }, { $addToSet: { roles: 'admin' } });
}

export async function registerWithEmail({ name, email, password, phone, role = 'customer' }) {
  if (!ALLOWED_SIGNUP_ROLES.includes(role)) {
    throw new HttpError(400, 'Invalid role');
  }
  if (!email || !password) {
    throw new HttpError(400, 'Email and password required');
  }
  if (password.length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters');
  }

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) throw new HttpError(409, 'This email is already registered. Try logging in instead.');

  // Phone is also unique. Check it up front so we can return a clear message
  // rather than letting MongoDB throw a raw duplicate-key error (which would
  // surface to the user as a generic 500).
  if (phone) {
    const phoneTaken = await User.findOne({ phone });
    if (phoneTaken) {
      throw new HttpError(409, 'This phone number is already registered. Try logging in instead.');
    }
  }

  let user;
  try {
    user = await User.create({
      name,
      email: email.toLowerCase(),
      phone,
      passwordHash: await hashPassword(password),
      roles: [role],
      lastLoginAt: new Date(),
    });
  } catch (err) {
    // Safety net for the race where two requests pass the checks above at the
    // same time, or any other unique-field collision. Turn Mongo's 11000 into
    // a clear 409 instead of a 500.
    if (err?.code === 11000) {
      const field = Object.keys(err.keyPattern || {})[0];
      const label = field === 'phone' ? 'phone number' : 'email';
      throw new HttpError(409, `This ${label} is already registered. Try logging in instead.`);
    }
    throw err;
  }

  // Auto-create the role-specific profile where needed
  if (role === 'delivery') {
    await DeliveryProfile.create({ user: user._id });
  }

  await maybePromoteAdmin(user);

  return { user: toPublic(user), token: issueToken(user) };
}

export async function loginWithEmail({ email, password }) {
  if (!email || !password) throw new HttpError(400, 'Email and password required');

  const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');
  if (!user || !user.passwordHash) throw new HttpError(401, 'Invalid credentials');
  if (user.isBlocked) throw new HttpError(403, 'Account disabled');

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw new HttpError(401, 'Invalid credentials');

  user.lastLoginAt = new Date();
  await maybePromoteAdmin(user);
  await user.save();

  return { user: toPublic(user), token: issueToken(user) };
}

/**
 * Verify a Google ID token and log the user in (creating the account if new).
 *
 * Uses Google's tokeninfo endpoint to validate the token signature server-side
 * — no extra dependency. We then check the audience matches our client ID and
 * the issuer is Google before trusting any claims.
 *
 * Account resolution order:
 *   1. Match an existing user by their linked Google subject id.
 *   2. Otherwise match by verified email (links Google to an existing account).
 *   3. Otherwise create a fresh customer account.
 */
export async function loginWithGoogle({ idToken }) {
  if (!idToken) throw new HttpError(400, 'Missing Google credential.');
  if (!env.GOOGLE_CLIENT_ID) {
    throw new HttpError(500, 'Google sign-in is not configured on the server.');
  }

  // Validate the token with Google and pull its claims.
  let payload;
  try {
    const resp = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
    );
    if (!resp.ok) throw new Error('tokeninfo rejected the token');
    payload = await resp.json();
  } catch {
    throw new HttpError(401, 'Could not verify your Google sign-in. Try again.');
  }

  // Security checks: audience must be our app, issuer must be Google.
  const audOk = payload.aud === env.GOOGLE_CLIENT_ID;
  const issOk =
    payload.iss === 'accounts.google.com' || payload.iss === 'https://accounts.google.com';
  if (!audOk || !issOk) {
    throw new HttpError(401, 'Invalid Google sign-in.');
  }

  const sub = payload.sub;
  const email = (payload.email || '').toLowerCase();
  const emailVerified = payload.email_verified === 'true' || payload.email_verified === true;
  const name = payload.name;
  const picture = payload.picture;
  if (!sub) throw new HttpError(401, 'Invalid Google sign-in.');

  // 1) Already linked?
  let user = await User.findOne({
    oauthProviders: { $elemMatch: { provider: 'google', providerId: sub } },
  });

  // 2) Link to an existing account by verified email.
  if (!user && email && emailVerified) {
    user = await User.findOne({ email });
    if (user) {
      user.oauthProviders = user.oauthProviders || [];
      user.oauthProviders.push({ provider: 'google', providerId: sub });
      if (!user.avatar && picture) user.avatar = picture;
      user.emailVerified = true;
    }
  }

  // 3) Brand-new account.
  if (!user) {
    user = new User({
      name: name || (email ? email.split('@')[0] : 'Customer'),
      email: email || undefined,
      emailVerified: !!emailVerified,
      avatar: picture || undefined,
      roles: ['customer'],
      oauthProviders: [{ provider: 'google', providerId: sub }],
    });
  }

  if (user.isBlocked) throw new HttpError(403, 'Account disabled');

  user.lastLoginAt = new Date();
  await maybePromoteAdmin(user);
  await user.save();

  return { user: toPublic(user), token: issueToken(user) };
}

/**
 * Admin field-onboarding: create (or reuse) a shop-owner account with an email
 * + a temporary password the admin sets. The owner is flagged
 * `mustChangePassword` so they're prompted to set their own password on first
 * login. Returns the User doc (not public) so the caller can attach a shop.
 *
 * If a user with this email already exists, we DON'T overwrite their password
 * (that would be a takeover risk) — we just ensure they have the 'shop' role
 * and reuse the account.
 */
export async function createShopOwnerAccount({ email, password, name, phone }) {
  const lower = email.toLowerCase();
  let user = await User.findOne({ email: lower });

  if (user) {
    if (!user.roles.includes('shop')) {
      user.roles.push('shop');
      await user.save();
    }
    return { user, reused: true };
  }

  user = await User.create({
    name: name || 'Shop owner',
    email: lower,
    phone: phone || undefined,
    passwordHash: await hashPassword(password),
    mustChangePassword: true,
    roles: ['shop'],
  });
  return { user, reused: false };
}

/**
 * Lets a logged-in user set a new password (used for the forced first-login
 * password change on admin-created accounts). Clears the mustChangePassword
 * flag once done.
 */
export async function setOwnPassword({ userId, newPassword }) {
  if (!newPassword || newPassword.length < 6) {
    throw new HttpError(400, 'Password must be at least 6 characters');
  }
  const user = await User.findById(userId);
  if (!user) throw new HttpError(404, 'User not found');
  user.passwordHash = await hashPassword(newPassword);
  user.mustChangePassword = false;
  await user.save();
  return { ok: true };
}

/**
 * Called after a successful OTP verification.
 * If a user with this phone exists, log them in. Otherwise create a
 * customer-by-default account (they can be upgraded to shop/delivery later
 * via the role-application flow).
 *
 * `roleHint` lets the signup form on the frontend say "I'm a shop owner" —
 * we honor it ONLY if there's no existing account.
 */
export async function loginOrCreateWithPhone({ phone, name, roleHint }) {
  let user = await User.findOne({ phone });

  if (user && user.isBlocked) throw new HttpError(403, 'Account disabled');

  if (!user) {
    const role = ALLOWED_SIGNUP_ROLES.includes(roleHint) ? roleHint : 'customer';
    user = await User.create({
      name,
      phone,
      phoneVerified: true,
      roles: [role],
      lastLoginAt: new Date(),
    });
    if (role === 'delivery') {
      await DeliveryProfile.create({ user: user._id });
    }
  } else {
    user.phoneVerified = true;
    user.lastLoginAt = new Date();
    await user.save();
  }

  await maybePromoteAdmin(user);

  return { user: toPublic(user), token: issueToken(user) };
}

export async function getCurrentUser(userId) {
  const user = await User.findById(userId);
  if (!user) throw new HttpError(404, 'User not found');
  return toPublic(user);
}

/**
 * Update the current user's editable profile fields: name, avatar, and the
 * address book. Email/phone are identity fields tied to auth, so we don't
 * change them here. Unspecified fields are left untouched.
 */
export async function updateProfile(userId, data) {
  const user = await User.findById(userId);
  if (!user) throw new HttpError(404, 'User not found');

  if (data.name !== undefined) user.name = data.name;
  if (data.avatar !== undefined) user.avatar = data.avatar || undefined;
  if (data.addresses !== undefined) {
    user.addresses = data.addresses.map((a) => ({
      label: a.label,
      line1: a.line1,
      line2: a.line2,
      city: a.city,
      state: a.state,
      pincode: a.pincode,
      location:
        a.location && a.location.lng != null && a.location.lat != null
          ? { type: 'Point', coordinates: [a.location.lng, a.location.lat] }
          : undefined,
    }));
  }

  await user.save();
  return toPublic(user);
}
