import { verifyToken } from '../utils/jwt.js';
import { User } from '../models/index.js';

/**
 * Reads `Authorization: Bearer <token>`, verifies, and attaches `req.user`.
 * Use `requireAuth` to block unauthenticated requests.
 * Use `optionalAuth` for endpoints that work for both (e.g. public product listing
 * that shows personalized data when logged in).
 */
async function loadUser(req) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  try {
    const decoded = verifyToken(token);
    const user = await User.findById(decoded.sub).lean();
    if (!user || user.isBlocked) return null;
    return user;
  } catch {
    return null;
  }
}

export async function optionalAuth(req, _res, next) {
  req.user = await loadUser(req);
  next();
}

export async function requireAuth(req, res, next) {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  req.user = user;
  next();
}
