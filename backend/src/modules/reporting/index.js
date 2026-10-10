export { createEventReportService } from './eventReport.js';
export { createReportingService } from './service.js';
export { createReportingController } from './controller.js';
export { createClubFinanceReportingRoutes } from './routesClub.js';

import { createEventReportingRoutes } from './routes.js';
import { createReportingService } from './service.js';
import { createReportingController } from './controller.js';
import { createClubFinanceReportingRoutes } from './routesClub.js';

export { createEventReportingRoutes, createEventReportingRoutes as createReportingRoutes };

export function createReportingModule({ db, financeSummary, timeZone, clock }) {
  const reporting = createReportingService({ db, financeSummary, timeZone, clock });
  const controller = createReportingController({ reporting });
  return Object.freeze({
    service: reporting,
    routes: (deps) => createClubFinanceReportingRoutes({ controller, ...deps }),
  });
}
