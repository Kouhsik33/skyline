import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { config } from './config/index.js';
import { logger } from './shared/logger.js';
import { requestIdMiddleware } from './shared/middleware/requestId.js';
import { createSessionMiddleware } from './shared/middleware/session.js';
import { errorHandler, notFoundHandler } from './shared/middleware/errorHandler.js';
import { globalRateLimit } from './shared/middleware/rateLimits.js';
import { csrfHeader } from './shared/middleware/csrfHeader.js';
import { db } from './db/knex.js';

/**
 * Options are for tests only: `beforeRoutes(router)` mounts test-only routes; `httpLogger`
 * replaces the request logger (to capture and check redaction). Production passes neither.
 */
export function createApp(container, { beforeRoutes, httpLogger } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY > 0) app.set('trust proxy', config.TRUST_PROXY);

  // First, so every response — including body-parser errors — carries X-Request-Id.
  app.use(requestIdMiddleware);
  app.use(helmet());
  // B5: API data is per-user and private. no-store keeps it out of the HTTP cache and bfcache, so
  // Back after logout (or a second user in the same tab) can never be served the first user's data.
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(
    cors({
      origin: config.CORS_ORIGIN,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  // LLD §9 request log fields: requestId and userId on every line (redaction is in the logger).
  app.use(
    pinoHttp({
      logger: httpLogger ?? logger,
      customProps: (req) => ({ requestId: req.requestId, userId: req.session?.userId ?? null }),
    }),
  );
  app.use(globalRateLimit);
  app.use(createSessionMiddleware());
  // ADR-004: every state-changing request needs X-Requested-With: soms (login/register exempt).
  app.use(csrfHeader);

  app.get('/api/v1/health', async (_req, res) => {
    try {
      await db.raw('SELECT 1');
      res.json({ data: { status: 'ok', db: 'ok' } });
    } catch {
      res.status(503).json({ data: { status: 'degraded', db: 'error' } });
    }
  });

  if (config.devToolsEnabled) {
    app.get('/api/v1/dev/college-roster', async (_req, res) => {
      const { listMockCollegeStudents } = await import(
        './modules/auth/verification/MockCollegeVerificationAdapter.js'
      );
      res.json({
        data: {
          source: 'students.mock.json',
          note:
            'Universal register: non-college emails become outsiders. College-domain emails are checked against this roster (email + fullName); optional studentIdentifier. POST /me/college-verification to retry.',
          students: listMockCollegeStudents(),
        },
      });
    });
  }

  const api = express.Router();
  beforeRoutes?.(api);
  Object.values(container.routes)
    .flat()
    .forEach((router) => api.use(router));
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
