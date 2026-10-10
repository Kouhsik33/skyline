import { Router } from 'express';
import { createWithTransaction } from '../db/transaction.js';
import { createAccess } from '../shared/access.js';
import { createRequireAuth, createOptionalAuth } from '../shared/middleware/actorAuth.js';
import { createAuthorize } from '../shared/middleware/clubRoleAuthorize.js';
import { createIdempotency } from '../shared/middleware/idempotencyG2.js';
import { csrfHeader } from '../shared/middleware/csrfHeader.js';
import { logger } from '../shared/logger.js';
import { createFinanceModule } from '../modules/finance/index.js';
import { createMerchandiseModule } from '../modules/merchandise/index.js';
import { createFundraisersModule } from '../modules/fundraisers/index.js';
import { createReportingModule } from '../modules/reporting/index.js';
import { createNotificationsModule } from '../modules/notifications/index.js';
import { createReservationExpiryJob } from '../jobs/definitions/reservationExpiry.js';
import { createNotificationDispatchJob } from '../jobs/definitions/notificationDispatch.js';
import { createGroup1Bridge, createAppClock, toGroup2Config } from './group1Bridge.js';

/**
 * Group 2 composition on live Group 1 data: finance, merchandise, fundraisers, reports,
 * notifications outbox, and the Group 2 job definitions.
 *
 * `registry` is the backend-wide payment handler registry, so Group 1's /payments/:id/simulate
 * and Group 2's engine dispatch to the same handlers (MERCH_ORDER included).
 * Options exist for tests only: clock, bridge overrides, notification adapters, file storage,
 * config overrides. Production passes none of them.
 */
export function wireGroup2({ db, config, bridge: bridgeIn, registry, clock: clockIn, bridgeOverrides = {}, notificationAdapters, storage, configOverrides = {} }) {
  const baseBridge = bridgeIn ?? createGroup1Bridge({ db, authRepository: null, authz: null });
  const bridge = Object.freeze({
    ...baseBridge,
    auth: { ...baseBridge.auth, ...bridgeOverrides.auth },
    clubs: { ...baseBridge.clubs, ...bridgeOverrides.clubs },
    events: { ...baseBridge.events, ...bridgeOverrides.events },
    memberships: { ...baseBridge.memberships, ...bridgeOverrides.memberships },
    pricing: { ...baseBridge.pricing, ...bridgeOverrides.pricing },
  });
  const g2Config = { ...toGroup2Config(config), ...configOverrides };
  const clock = clockIn ?? createAppClock();
  const withTransaction = createWithTransaction(db);
  const access = createAccess({ clubs: bridge.clubs, events: bridge.events });

  const routeDeps = Object.freeze({
    requireAuth: createRequireAuth({ auth: bridge.auth }),
    optionalAuth: createOptionalAuth({ auth: bridge.auth }),
    requireClubRole: createAuthorize({ access }),
    idempotency: createIdempotency({ db, clock, logger }),
    csrfHeader,
  });

  let fundraisers = null;
  const finance = createFinanceModule({
    db,
    withTransaction,
    clock,
    config: g2Config,
    logger,
    access,
    auth: bridge.auth,
    getEventClub: (eventId) => bridge.events.getEventClub(eventId),
    getFundraiserRef: (fundraiserId) => fundraisers.getFundraiserRef(fundraiserId),
    storage,
    registry,
  });

  const notifications = createNotificationsModule({ db, clock, auth: bridge.auth, config: g2Config, logger, adapters: notificationAdapters });

  const merchandise = createMerchandiseModule({
    db,
    withTransaction,
    clock,
    config: g2Config,
    access,
    auth: bridge.auth,
    clubs: bridge.clubs,
    pricing: bridge.pricing,
    memberships: bridge.memberships,
    payments: finance.payments,
    ledger: finance.ledger,
    notifications,
  });

  finance.payments.registerHandler(merchandise.paymentHandler);

  fundraisers = createFundraisersModule({
    db,
    clock,
    access,
    clubs: bridge.clubs,
    auth: bridge.auth,
    fundraiserMoney: finance.ledger.fundraiserMoney,
    timeZone: g2Config.timezone,
    tolerancePct: g2Config.fundraiserAtRiskTolerancePct,
  });

  const reporting = createReportingModule({
    db,
    financeSummary: (clubId, period) => finance.summary.summary(clubId, period),
    timeZone: g2Config.timezone,
    clock,
  });

  const router = Router();
  router.use(finance.financeRoutes(routeDeps));
  router.use(finance.clubPaymentRoutes(routeDeps));
  router.use(merchandise.routes(routeDeps));
  router.use(fundraisers.routes(routeDeps));
  router.use(reporting.routes(routeDeps));

  // Job definitions owned by Group 2 (LLD §7). reservation-expiry is purpose-agnostic (OQ-09):
  // it settles every expired payment EXPIRED, and each purpose handler releases its hold.
  const jobDefinitions = {
    'reservation-expiry': {
      cron: '* * * * *',
      daily: false,
      run: createReservationExpiryJob({ payments: finance.payments, withTransaction, config: g2Config, logger }),
    },
    'notification-dispatch': { cron: '* * * * *', daily: false, run: createNotificationDispatchJob({ notifications }) },
  };

  return Object.freeze({
    router,
    routeDeps,
    devRouters: [finance.devRoutes(routeDeps), notifications.devRoutes(routeDeps)],
    jobDefinitions,
    finance,
    merchandise,
    fundraisers,
    notifications,
    reporting,
    bridge,
    clock,
    withTransaction,
    config: g2Config,
  });
}
