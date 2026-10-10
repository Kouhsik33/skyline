import { AppError } from '../errors.js';
import { db } from '../../db/knex.js';

// Session check for Group 1 routes. The user row is re-read on every request so a deactivated
// account loses access immediately (LLD §2.1), not when its session expires.

async function activeUserId(req) {
  const userId = req.session?.userId;
  if (!userId) return null;
  const user = await db('users').where({ id: userId }).first('id', 'is_active');
  if (user?.is_active) return user.id;
  await new Promise((resolve) => req.session.destroy(() => resolve()));
  return null;
}

export async function requireAuth(req, _res, next) {
  try {
    const userId = await activeUserId(req);
    if (!userId) return next(new AppError('UNAUTHENTICATED', 401, 'Authentication required'));
    req.userId = userId;
    return next();
  } catch (err) {
    return next(err);
  }
}

export async function optionalAuth(req, _res, next) {
  try {
    const userId = await activeUserId(req);
    if (userId) req.userId = userId;
    return next();
  } catch (err) {
    return next(err);
  }
}
