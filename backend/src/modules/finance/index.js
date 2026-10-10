import { createLedgerService } from './ledger/service.js';
import { createHandlerRegistry } from './payments/handlerRegistry.js';
import { createPaymentService } from './payments/service.js';
import { createSimulator } from './payments/simulator.js';
import { createPaymentController } from './payments/controller.g2.js';
import { createClubPaymentRoutes, createDevPaymentRoutes, createPaymentRoutes } from './payments/routes.g2.js';
import { createLocalFileStorage } from './files/LocalFileStorage.js';
import { assertFileStorage } from './files/FileStorage.js';
import { createFileService } from './files/service.js';
import { createUpload } from './files/upload.js';
import { createExpenseService } from './expenses/service.js';
import { createIncomeService } from './income/service.js';
import { createBudgetService } from './budgets/service.js';
import { createFinanceSummaryService } from './summary/service.js';
import { createFinanceController } from './controller.js';
import { createFinanceRoutes } from './routes.js';
import { createFundraiserLinkCheck } from './fundraiserLink.js';

// Public API of the finance module (M9). Other modules use only what is exported here:
//   payments.create / settle / getById / registerHandler, ledger.post / postPaymentIncome /
//   fundraiserMoney, simulator.decide (LLD §2.10, scope map §4.2).
// Cross-module lookups (event club, fundraiser club) are injected functions (OQ-25).

export function createFinanceModule({ db, withTransaction, clock, config, logger, access, auth, getEventClub, getFundraiserRef, storage, registry: sharedRegistry }) {
  const timeZone = config.timezone;
  // The container passes the backend-wide registry so every engine dispatches to the same handlers.
  const registry = sharedRegistry ?? createHandlerRegistry();
  const ledger = createLedgerService({ db, logger });
  const payments = createPaymentService({ db, withTransaction, clock, registry, timeZone, logger });
  const simulator = createSimulator({ autopayOutcome: config.simAutopayOutcome });
  const paymentController = createPaymentController({ payments });

  const fileStorage = assertFileStorage(storage ?? createLocalFileStorage({ root: config.uploadDir, clock }));
  const files = createFileService({ db, storage: fileStorage, maxBytes: config.maxUploadBytes, logger });
  const upload = createUpload({ maxBytes: config.maxUploadBytes });
  const assertFundraiserLinkable = createFundraiserLinkCheck(getFundraiserRef);
  const common = { db, withTransaction, clock, access, ledger, files, timeZone };
  const expenses = createExpenseService({ ...common, auth, getEventClub, assertFundraiserLinkable });
  const income = createIncomeService({ ...common, assertFundraiserLinkable });
  const budgets = createBudgetService({ db, withTransaction, access, timeZone });
  const summary = createFinanceSummaryService({ db, clock, budgets, auth, timeZone });
  const controller = createFinanceController({ expenses, income, budgets, summary });

  return Object.freeze({
    payments,
    ledger,
    simulator,
    expenses,
    income,
    budgets,
    summary,
    storage: fileStorage,
    financeRoutes: (deps) => createFinanceRoutes({ controller, upload, ...deps }),
    paymentRoutes: (deps) => createPaymentRoutes({ controller: paymentController, ...deps }),
    clubPaymentRoutes: (deps) => createClubPaymentRoutes({ controller: paymentController, ...deps }),
    routes: (deps) => {
      const router = createPaymentRoutes({ controller: paymentController, ...deps });
      router.use(createFinanceRoutes({ controller, upload, ...deps }));
      return router;
    },
    devRoutes: (deps) => createDevPaymentRoutes({ controller: paymentController, ...deps }),
  });
}
