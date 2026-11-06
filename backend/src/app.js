import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { config } from './config/index.js';
import { logger } from './shared/logger.js';
import { requestIdMiddleware } from './shared/middleware/requestId.js';
import { createSessionMiddleware } from './shared/middleware/session.js';
import { errorHandler } from './shared/middleware/errorHandler.js';
import { globalRateLimit } from './shared/middleware/rateLimits.js';
import { db } from './db/knex.js';

export function createApp(container) {
  const app = express();

  // Behind reverse proxies (e.g. Render, Cloudflare, CRA dev server proxy).
  // Required so express and express-session detect HTTPS correctly and issue secure cookies.
  app.set('trust proxy', 1);

  app.use(helmet());
  const corsOrigins = config.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);
  app.use(
    cors({
      origin: config.isProduction
        ? corsOrigins.length === 1
          ? corsOrigins[0]
          : corsOrigins
        : (origin, cb) => {
            if (!origin || corsOrigins.includes(origin)) return cb(null, true);
            if (/^http:\/\/localhost:\d+$/.test(origin)) return cb(null, true);
            cb(null, false);
          },
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(requestIdMiddleware);
  app.use(pinoHttp({ logger }));
  app.use(globalRateLimit);
  app.use(createSessionMiddleware());

  app.get('/api/v1/health', async (_req, res) => {
    try {
      await db.raw('SELECT 1');
      res.json({ data: { status: 'ok', db: 'ok' } });
    } catch {
      res.status(503).json({ data: { status: 'degraded', db: 'error' } });
    }
  });

  app.get('/api/v1/users', async (_req, res) => {
    const users = await db('users').select('id', 'email', 'full_name', 'is_active', 'created_at');
    res.json({ data: { users } });
  });

  if (config.devToolsEnabled && config.COLLEGE_VERIFICATION_MODE === 'mock') {
    app.get('/api/v1/dev/college-roster', async (_req, res) => {
      const { listMockCollegeStudents } = await import(
        './modules/auth/verification/MockCollegeVerificationAdapter.js'
      );
      res.json({
        data: {
          source: 'students.mock.json',
          note: 'COLLEGE_VERIFICATION_MODE=mock — switch to database + npm run seed for Postgres roster.',
          students: listMockCollegeStudents(),
        },
      });
    });
  }

  const api = express.Router();
  Object.values(container.routes)
    .filter(Boolean)
    .forEach((router) => api.use(router));
  app.use('/api/v1', api);

  app.use(errorHandler);

  return app;
}

