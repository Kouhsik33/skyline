import { AppError } from '../errors.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function csrfHeader(req, _res, next) {
  if (!MUTATING.has(req.method)) return next();
  if (req.path.startsWith('/api/v1/auth/login') || req.path.startsWith('/api/v1/auth/register')) {
    return next();
  }
  if (req.headers['x-requested-with'] !== 'soms') {
    return next(new AppError('FORBIDDEN', 403, 'Missing X-Requested-With header', { reason: 'CSRF_HEADER_MISSING' }));
  }
  return next();
}
