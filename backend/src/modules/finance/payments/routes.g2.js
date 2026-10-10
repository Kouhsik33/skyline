import { Router } from 'express';
import { validate } from '../../../shared/middleware/validate.js';
import { clubIdParams, clubPaymentsQuery, myPaymentsQuery, paymentIdParams, simulateBody } from './schemas.js';

// LLD §4.4. Order per route: requireAuth → idempotency [IDEM] → validate → authorize → controller.

export function createPaymentRoutes({ controller, requireAuth, idempotency, requireClubRole }) {
  const router = Router();

  router.get('/payments/:paymentId', requireAuth, validate({ params: paymentIdParams }), controller.get);

  router.post(
    '/payments/:paymentId/simulate',
    requireAuth,
    idempotency(),
    validate({ params: paymentIdParams, body: simulateBody }),
    controller.simulate,
  );

  router.get('/me/payments', requireAuth, validate({ query: myPaymentsQuery }), controller.listMine);

  router.get(
    '/clubs/:clubId/payments',
    requireAuth,
    validate({ params: clubIdParams, query: clubPaymentsQuery }),
    requireClubRole(['TREASURER', 'CLUB_HEAD']),
    controller.listForClub,
  );

  return router;
}

/** GET /clubs/:clubId/payments (TR, CH; LLD §4.4). The other payment routes are Group 1's. */
export function createClubPaymentRoutes({ controller, requireAuth, requireClubRole }) {
  const router = Router();
  router.get(
    '/clubs/:clubId/payments',
    requireAuth,
    validate({ params: clubIdParams, query: clubPaymentsQuery }),
    requireClubRole(['TREASURER', 'CLUB_HEAD']),
    controller.listForClub,
  );
  return router;
}

/** Dev tools only (LLD §4.11): resolves any payment, including AutoPay PENDING ones. */
export function createDevPaymentRoutes({ controller, requireAuth }) {
  const router = Router();
  router.post(
    '/dev/payments/:paymentId/simulate',
    requireAuth,
    validate({ params: paymentIdParams, body: simulateBody }),
    controller.devSimulate,
  );
  return router;
}
