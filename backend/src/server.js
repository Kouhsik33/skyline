import { createContainer } from './container.js';
import { createApp } from './app.js';
import { config } from './config/index.js';
import { logger } from './shared/logger.js';
import { createScheduler } from './jobs/scheduler.js';

const container = createContainer();
const app = createApp(container);
const scheduler = createScheduler({ registry: container.jobs, timeZone: config.APP_TIMEZONE, logger });
if (config.JOBS_ENABLED) scheduler.start();
else logger.info('Jobs disabled');

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'SOMS backend listening');
});

async function shutdown() {
  await scheduler.stop();
  server.close(() => {
    container.db.destroy().finally(() => process.exit(0));
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
