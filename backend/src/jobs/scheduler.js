import cron from 'node-cron';

// node-cron registrations for every job in the registry (LLD §7), in APP_TIMEZONE (IST).
// Each tick goes through runJob: advisory lock per job name, job_runs row per day for daily jobs,
// failures recorded and logged. Disabled with JOBS_ENABLED=false (tests call jobs directly).

export function createScheduler({ registry, timeZone, logger }) {
  const tasks = [];
  return Object.freeze({
    start() {
      for (const name of registry.names()) {
        const { cron: expression } = registry.get(name);
        tasks.push(
          cron.schedule(
            expression,
            () => {
              registry.run(name).catch((err) => logger.error({ err, job: name }, 'scheduler: job crashed'));
            },
            { timezone: timeZone, name },
          ),
        );
      }
      logger.info({ jobs: registry.names() }, 'Scheduler started');
    },
    async stop() {
      await Promise.all(tasks.map((t) => t.stop()));
      tasks.length = 0;
    },
  });
}
