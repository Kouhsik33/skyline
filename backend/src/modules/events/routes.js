import { Router } from 'express';
import { requireAuth } from '../../shared/middleware/requireAuth.js';
import { csrfHeader } from '../../shared/middleware/csrfHeader.js';
import { validate } from '../../shared/middleware/validate.js';
import { requireIdempotencyKey, idempotencyMiddleware } from '../../shared/middleware/idempotency.js';
import { authorize } from '../../shared/middleware/authorize.js';
import { eventIdParam, clubIdParam, bookingBody, checkInBody, createEventBody } from './schemas.js';

export function createEventRoutes({ eventController, authz }) {
  const router = Router();

  router.get('/events', eventController.list);
  router.get('/events/:eventId', validate({ params: eventIdParam }), eventController.get);
  router.get(
    '/events/:eventId/price-quote',
    requireAuth,
    validate({ params: eventIdParam }),
    eventController.quote,
  );

  router.post(
    '/clubs/:clubId/events',
    requireAuth,
    csrfHeader,
    validate({ params: clubIdParam, body: createEventBody }),
    authorize(authz, { role: 'CH', resolveScope: async (req) => ({ clubId: req.params.clubId }) }),
    eventController.create,
  );

  router.post(
    '/events/:eventId/publish',
    requireAuth,
    csrfHeader,
    validate({ params: eventIdParam }),
    eventController.publish,
  );

  router.post(
    '/events/:eventId/bookings',
    requireAuth,
    csrfHeader,
    requireIdempotencyKey,
    idempotencyMiddleware(),
    validate({ params: eventIdParam, body: bookingBody }),
    eventController.book,
  );

  router.post(
    '/events/:eventId/check-ins',
    requireAuth,
    csrfHeader,
    requireIdempotencyKey,
    idempotencyMiddleware(),
    validate({ params: eventIdParam, body: checkInBody }),
    eventController.checkIn,
  );

  return router;
}
