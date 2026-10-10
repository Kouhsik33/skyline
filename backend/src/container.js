import { db } from './db/knex.js';
import { config } from './config/index.js';
import { now } from './shared/clock.js';
import { createAuditRepository } from './shared/auditRepository.js';
import { createPricingPolicy } from './modules/pricing/PricingPolicy.js';

import {
  createAuthRepository,
  createAuthService,
  createAuthController,
  createAuthRoutes,
  createMockCollegeVerificationAdapter,
  createUnconfiguredCollegeVerificationAdapter,
} from './modules/auth/index.js';

import {
  createClubRepository,
  createClubService,
  createClubController,
  createClubRoutes,
  createClubAuthz,
} from './modules/clubs/index.js';

import {
  createPaymentRepository,
  createPaymentService,
  createPaymentHandlerRegistry,
  createPaymentController,
  createPaymentRoutes,
} from './modules/finance/payments/index.js';

import { createLedgerService } from './modules/finance/ledger/index.js';
import { logger } from './shared/logger.js';
import { createGroup1Bridge } from './integration/group1Bridge.js';
import { wireGroup2 } from './integration/wireGroup2.js';

import { createNotificationRepository, createNotificationService } from './modules/notifications/index.js';

import {
  createMembershipRepository,
  createMembershipService,
  createPlansService,
  createMembershipController,
  createMembershipRoutes,
  createMembershipPaymentHandler,
  createMembershipRenewalPaymentHandler,
} from './modules/memberships/index.js';

import {
  createEventRepository,
  createEventService,
  createEventController,
  createEventRoutes,
  createTicketPaymentHandler,
} from './modules/events/index.js';

import {
  createAnnouncementRepository,
  createAnnouncementService,
  createAnnouncementController,
  createAnnouncementRoutes,
} from './modules/announcements/index.js';

import { createEventReportService, createEventReportingRoutes } from './modules/reporting/index.js';

import { createJobRunner } from './jobs/runJob.js';
import { createJobRegistry } from './jobs/registry.js';
import { createJobDevRoutes } from './jobs/devRoutes.js';
import { now as clockNow, todayIST } from './shared/clock.js';
import { createMembershipExpiryJob } from './jobs/definitions/membershipExpiry.js';
import { createRenewalRemindersJob } from './jobs/definitions/renewalReminders.js';
import { createAutopayRenewalsJob } from './jobs/definitions/autopayRenewals.js';

/**
 * Composition root. `options` are for tests only:
 *   paymentHandlerOverrides  { PURPOSE: handler } replacing a registered handler
 *   wrapPaymentHandler       (handler) => handler, e.g. to count calls around the real handler
 *   devToolsEnabled          overrides config.devToolsEnabled
 *   group2                   passed to wireGroup2 (bridgeOverrides, notificationAdapters, storage, configOverrides)
 */
export function createContainer(options = {}) {
  const { paymentHandlerOverrides = {}, wrapPaymentHandler = (h) => h, group2: group2Options = {} } = options;
  const devToolsEnabled = options.devToolsEnabled ?? config.devToolsEnabled;
  const auditRepository = createAuditRepository(db);
  const authz = createClubAuthz({ db });

  const verificationAdapter =
    config.COLLEGE_VERIFICATION_MODE === 'mock'
      ? createMockCollegeVerificationAdapter()
      : createUnconfiguredCollegeVerificationAdapter();

  const clubRepository = createClubRepository({ db });
  const authRepository = createAuthRepository({ db });

  const clubService = createClubService({ clubRepository, authRepository, auditRepository, authz });

  const authService = createAuthService({
    authRepository,
    verificationAdapter,
    clubsModule: clubService,
    auditRepository,
  });

  const ledgerService = createLedgerService({ db, logger });
  const group1Bridge = createGroup1Bridge({ db, authRepository, authz });

  const notificationRepository = createNotificationRepository({ db });
  const notificationService = createNotificationService({ notificationRepository });

  const paymentRepository = createPaymentRepository({ db });
  // One registry for both payment engines (Group 1 service.g1 and Group 2 service).
  const handlerRegistry = createPaymentHandlerRegistry();
  const registerHandler = (handler) => handlerRegistry.register(wrapPaymentHandler(paymentHandlerOverrides[handler.purpose] ?? handler));

  const membershipRepository = createMembershipRepository({ db });

  const paymentService = createPaymentService({
    paymentRepository,
    handlerRegistry,
    ledgerService,
    config,
  });

  const membershipService = createMembershipService({
    membershipRepository,
    paymentService,
    authService,
    authz,
    clubRepository,
  });

  registerHandler(
    createMembershipPaymentHandler({
      membershipRepository,
      clubRepository,
      ledgerService,
      notificationService,
    }),
  );
  registerHandler(
    createMembershipRenewalPaymentHandler({
      membershipRepository,
      clubRepository,
      ledgerService,
      notificationService,
    }),
  );

  const eventRepository = createEventRepository({ db });

  registerHandler(
    createTicketPaymentHandler({
      eventRepository,
      ledgerService,
      notificationService,
      authService,
    }),
  );

  const pricingPolicy = createPricingPolicy(now, config.PRICING_COMBINATION_MODE);

  const eventService = createEventService({
    eventRepository,
    membershipService,
    pricingPolicy,
    paymentService,
    authz,
    config,
  });

  const plansService = createPlansService({ membershipRepository, authz, authService });

  const announcementRepository = createAnnouncementRepository({ db });
  const announcementService = createAnnouncementService({
    announcementRepository,
    membershipRepository,
    eventRepository,
    authRepository,
    notificationService,
    authz,
  });

  const eventReportService = createEventReportService({ db });

  const authController = createAuthController({ authService });
  const clubController = createClubController({ clubService });
  const paymentController = createPaymentController({ paymentService });
  const membershipController = createMembershipController({ membershipService, plansService });
  const eventController = createEventController({ eventService });
  const announcementController = createAnnouncementController({ announcementService });

  const routes = {
    auth: createAuthRoutes({ authController }),
    clubs: createClubRoutes({ clubController, authz }),
    payments: createPaymentRoutes({ paymentController }),
    memberships: createMembershipRoutes({ membershipController, authz }),
    events: createEventRoutes({ eventController, authz }),
    announcements: createAnnouncementRoutes({ announcementController, authz }),
    reporting: createEventReportingRoutes({ eventReportService, authz, eventRepository }),
  };

  const group2 = wireGroup2({ db, config, bridge: group1Bridge, registry: handlerRegistry, ...group2Options });
  routes.group2 = group2.router;

  // Every scheduled job (LLD §7) in one table, run through the Group 2 job runner (T-51):
  // advisory lock per job, one job_runs row per day for daily jobs, failures recorded.
  const membershipExpiry = createMembershipExpiryJob({ db });
  const renewalReminders = createRenewalRemindersJob({ db, notificationService });
  const autopayRenewals = createAutopayRenewalsJob({ db, membershipRepository, paymentService, authService, notificationService });
  const runJob = createJobRunner({ db, clock: { now: clockNow, todayIST }, logger });
  const jobs = createJobRegistry({
    runJob,
    clock: { now: clockNow, todayIST },
    timeZone: config.APP_TIMEZONE,
    definitions: {
      'membership-expiry': { cron: '5 0 * * *', daily: true, run: () => membershipExpiry.execute() },
      'autopay-renewals': { cron: '0 6 * * *', daily: true, run: () => autopayRenewals.execute() },
      'renewal-reminders': { cron: '0 9 * * *', daily: true, run: () => db.transaction((trx) => renewalReminders.execute(trx)) },
      ...group2.jobDefinitions,
    },
  });

  // Dev tools (LLD §4.11): 404 unless DEV_TOOLS_ENABLED and not production.
  if (devToolsEnabled) {
    routes.dev = [...group2.devRouters, createJobDevRoutes({ registry: jobs, requireAuth: group2.routeDeps.requireAuth })];
  }

  return {
    db,
    config,
    routes,
    jobs,
    runJob,
    handlerRegistry,
    group2,
    services: {
      authService,
      clubService,
      membershipService,
      eventService,
      paymentService,
      announcementService,
    },
  };
}
