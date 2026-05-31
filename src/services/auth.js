import bcrypt from 'bcryptjs';
import { User, DeliveryProfile } from '../models/index.js';
import { signToken } from '../utils/jwt.js';
import { HttpError } from '../middleware/error.js';
import { ADMIN_EMAILS } from '../config/env.js';

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
