/**
 * Require the authenticated user to have at least one of the given roles.
 * Use after `requireAuth`.
 *
 *   router.get('/admin/users', requireAuth, requireRole('admin'), handler)
 */
export function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const has = req.user.roles?.some((r) => allowed.includes(r));
    if (!has) return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}
