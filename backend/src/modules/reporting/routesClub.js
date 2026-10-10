import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../shared/middleware/validate.js';
import { isoDateSchema } from '../../shared/dates.js';

const clubIdParams = z.object({ clubId: z.string().uuid() });
const periodQuery = z
  .object({ from: isoDateSchema.optional(), to: isoDateSchema.optional() })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'from must not be after to', path: ['from'] });

export function createClubFinanceReportingRoutes({ controller, requireAuth, requireClubRole }) {
  const r = Router();
  r.get(
    '/clubs/:clubId/reports/finance',
    requireAuth,
    validate({ params: clubIdParams, query: periodQuery }),
    requireClubRole(['CLUB_HEAD', 'TREASURER']),
    controller.financeReport,
  );
  for (const [path, handler] of [
    ['/clubs/:clubId/reports/memberships', controller.membershipReport],
    ['/clubs/:clubId/reports/merchandise', controller.merchandiseReport],
  ]) {
    r.get(path, requireAuth, validate({ params: clubIdParams }), requireClubRole(['CLUB_HEAD', 'TREASURER']), handler);
  }
  return r;
}
