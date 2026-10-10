import request from 'supertest';
import { createContainer } from '../../src/container.js';
import { createApp } from '../../src/app.js';
import { createLogger } from '../../src/shared/logger.js';
import { getTestDb } from './testDb.js';
import { createTestClock } from './testClock.js';

/** Group 1 helper: the production composition, unchanged. */
export function createTestApp() {
  const container = createContainer();
  const app = createApp(container);
  return { app, container };
}

// ---- Group 2 harness on the real merged container -------------------------------------------
// buildTestContext() builds the production container and app with test-only options:
//   - a test clock (shared setClock → both groups see the same time),
//   - every payment handler wrapped to record calls (optionally fail or delay), then delegate to
//     the REAL Group 1 / Group 2 handler,
//   - Group 1 bridge overrides (e.g. pricing.quoteMerchItem for a specific price), notification
//     adapters, file storage, Group 2 config overrides,
//   - one test-only route, POST /api/v1/__test/sign-in { userId } (sets the session like login).

const ENV_TO_G2 = { DEV_NOTIFY_FAIL_CHANNEL: 'devNotifyFailChannel', NOTIFY_MODE: 'notifyMode' };

function recordingWrapper(calls, { failOn, delayMs = 0, purposes } = {}) {
  return (handler) => {
    if (purposes && !purposes.includes(handler.purpose)) return handler;
    return {
      purpose: handler.purpose,
      async onSucceeded(payment, trx) {
        calls.push({ purpose: handler.purpose, hook: 'onSucceeded', paymentId: payment.id });
        if (failOn === 'onSucceeded') throw new Error('handler failure (test)');
        if (delayMs) await trx.raw('SELECT pg_sleep(?)', [delayMs / 1000]);
        return handler.onSucceeded(payment, trx);
      },
      async onFailed(payment, reason, trx) {
        calls.push({ purpose: handler.purpose, hook: 'onFailed', paymentId: payment.id, reason });
        if (failOn === 'onFailed') throw new Error('handler failure (test)');
        if (delayMs) await trx.raw('SELECT pg_sleep(?)', [delayMs / 1000]);
        return handler.onFailed(payment, reason, trx);
      },
    };
  };
}

export function buildTestContext({ configOverrides = {}, handlerOptions, paymentHandlerOverrides, extraRoutes, group1Overrides, storage, notificationAdapters, logger } = {}) {
  const db = getTestDb();
  const clock = createTestClock();
  const handlerCalls = [];
  const g2ConfigOverrides = {};
  for (const [k, v] of Object.entries(configOverrides)) if (ENV_TO_G2[k]) g2ConfigOverrides[ENV_TO_G2[k]] = v || null;

  const container = createContainer({
    wrapPaymentHandler: recordingWrapper(handlerCalls, handlerOptions),
    paymentHandlerOverrides,
    devToolsEnabled: configOverrides.DEV_TOOLS_ENABLED !== 'false',
    group2: { clock, bridgeOverrides: group1Overrides, notificationAdapters, storage, configOverrides: g2ConfigOverrides },
  });
  const app = createApp(container, {
    httpLogger: logger,
    beforeRoutes(router) {
      router.post('/__test/sign-in', async (req, res) => {
        await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
        req.session.userId = req.body.userId;
        await new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
        res.status(204).end();
      });
      extraRoutes?.(router);
    },
  });

  const g2 = container.group2;
  const facade = {
    ...container,
    finance: g2.finance,
    merchandise: g2.merchandise,
    fundraisers: g2.fundraisers,
    notifications: g2.notifications,
    reporting: g2.reporting,
    withTransaction: g2.withTransaction,
    config: g2.config,
    jobs: container.jobs,
    runJob: container.runJob,
  };

  async function signIn(userId) {
    const agent = request.agent(app);
    await agent.post('/api/v1/__test/sign-in').set('X-Requested-With', 'soms').send({ userId }).expect(204);
    return agent;
  }

  return {
    config: g2.config,
    db,
    clock,
    container: facade,
    app,
    signIn,
    handlerCalls,
    logger: logger ?? createLogger({ level: 'silent' }),
    close: async () => clock.reset(),
  };
}

export const idemKey = () => crypto.randomUUID();
