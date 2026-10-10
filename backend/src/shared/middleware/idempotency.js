import { db } from '../../db/knex.js';
import { logger } from '../logger.js';
import { now, todayIST } from '../clock.js';
import { createIdempotency } from './idempotencyG2.js';

// One Idempotency-Key implementation for both groups (LLD §3.1, §4.0; OQ-23). Group 1 routes keep
// their two names; both now delegate to the atomic Group 2 middleware:
//   key must be a UUID (IDEMPOTENCY_KEY_REQUIRED), claim is INSERT … ON CONFLICT (no race → no
//   500), same key + different request → IDEMPOTENCY_KEY_REUSED, concurrent duplicate →
//   REQUEST_IN_PROGRESS, response stored before it is sent, 5xx releases the key, 24 h expiry.

const middleware = createIdempotency({ db, clock: { now, todayIST }, logger })();

/** Kept for Group 1 route definitions; key validation now happens in idempotencyMiddleware. */
export function requireIdempotencyKey(_req, _res, next) {
  next();
}

export function idempotencyMiddleware() {
  return middleware;
}
