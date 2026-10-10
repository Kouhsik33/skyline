import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestContext } from '../helpers/testApp.js';
import { truncateAll } from '../helpers/testDb.js';
import { makeUser } from '../fixtures/factories.js';
import { createScheduler } from '../../src/jobs/scheduler.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { createLogger } from '../../src/shared/logger.js';

// T-51 — job runner (advisory lock + job_runs), registry, scheduler, dev run endpoint (LLD §7).

const H = { 'X-Requested-With': 'soms' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('runJob (T-51)', () => {
  let ctx;
  beforeAll(() => {
    ctx = buildTestContext();
  });
  afterAll(() => ctx.close());
  beforeEach(() => truncateAll(ctx.db));

  it('daily job runs once per run key; another day runs again (duplicate-run test)', async () => {
    let calls = 0;
    const fn = async () => ({ processed: (calls += 1) });
    expect(await ctx.container.runJob('membership-expiry', '2026-11-01', fn)).toMatchObject({ status: 'SUCCEEDED', summary: { processed: 1 } });
    expect(await ctx.container.runJob('membership-expiry', '2026-11-01', fn)).toMatchObject({ status: 'ALREADY_RAN' });
    expect(await ctx.container.runJob('membership-expiry', '2026-11-02', fn)).toMatchObject({ status: 'SUCCEEDED' });
    expect(calls).toBe(2);
    const runs = await ctx.db('job_runs').orderBy('run_key');
    expect(runs.map((r) => [r.run_key, r.status, r.summary])).toEqual([['2026-11-01', 'SUCCEEDED', { processed: 1 }], ['2026-11-02', 'SUCCEEDED', { processed: 2 }]]);
  });

  it('concurrent runs of the same job: one executes (advisory lock / unique run key)', async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      await sleep(100);
      return {};
    };
    const results = await Promise.all(Array.from({ length: 5 }, () => ctx.container.runJob('renewal-reminders', '2026-11-01', fn)));
    expect(calls).toBe(1);
    expect(results.filter((r) => r.status === 'SUCCEEDED')).toHaveLength(1);
    expect(results.every((r) => ['SUCCEEDED', 'SKIPPED_LOCKED', 'ALREADY_RAN'].includes(r.status))).toBe(true);
  });

  it('a failure is recorded (FAILED + error), logged, returned — and the same day can be retried (OQ-56)', async () => {
    const boom = await ctx.container.runJob('autopay-renewals', '2026-11-01', async () => {
      throw new Error('db hiccup');
    });
    expect(boom).toMatchObject({ status: 'FAILED', error: 'db hiccup' });
    expect(await ctx.db('job_runs').first()).toMatchObject({ status: 'FAILED', error: 'db hiccup' });
    expect(await ctx.container.runJob('autopay-renewals', '2026-11-01', async () => ({ ok: true }))).toMatchObject({ status: 'SUCCEEDED' });
    expect(await ctx.db('job_runs')).toHaveLength(1);
  });

  it('minute jobs (no run key) keep no job_runs row; the lock is released after each run', async () => {
    expect(await ctx.container.runJob('notification-dispatch', null, async () => ({}))).toMatchObject({ status: 'SUCCEEDED' });
    expect(await ctx.container.runJob('notification-dispatch', null, async () => ({}))).toMatchObject({ status: 'SUCCEEDED' });
    expect(await ctx.db('job_runs')).toHaveLength(0);
    const { rows } = await ctx.db.raw("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'");
    expect(rows[0].n).toBe(0);
  });

  it('registry: daily jobs get the IST date of asOf as run key', async () => {
    const seen = [];
    const registry = createJobRegistry({
      runJob: ctx.container.runJob,
      clock: ctx.clock,
      timeZone: 'Asia/Kolkata',
      definitions: { 'daily-x': { cron: '0 9 * * *', daily: true, run: async ({ now }) => seen.push(now.toISOString()) } },
    });
    const r = await registry.run('daily-x', { asOf: new Date('2026-11-01T20:00:00Z') }); // 2026-11-02 01:30 IST
    expect(r).toMatchObject({ status: 'SUCCEEDED', runKey: '2026-11-02' });
    expect(seen).toEqual(['2026-11-01T20:00:00.000Z']);
    expect(await registry.run('unknown')).toBeNull();
  });

  it('scheduler registers every job with node-cron in APP_TIMEZONE and stops cleanly', async () => {
    const scheduler = createScheduler({ registry: ctx.container.jobs, timeZone: 'Asia/Kolkata', logger: createLogger({ level: 'silent' }) });
    const { default: cron } = await import('node-cron');
    const before = cron.getTasks().size;
    scheduler.start();
    expect(cron.getTasks().size - before).toBe(ctx.container.jobs.names().length); // all 5 jobs of both groups
    await scheduler.stop();
  });
});

describe('POST /dev/jobs/:jobName/run', () => {
  let ctx;
  beforeAll(() => {
    ctx = buildTestContext();
  });
  afterAll(() => ctx.close());

  it('runs a registered job (asOf) for a signed-in user; unknown job 404; anonymous 401', async () => {
    await truncateAll(ctx.db);
    const agent = await ctx.signIn((await makeUser(ctx.db)).id);
    const res = await agent.post('/api/v1/dev/jobs/reservation-expiry/run').set(H).send({ asOf: '2026-11-01T12:00:00+05:30' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ job: 'reservation-expiry', status: 'SUCCEEDED', summary: { due: 0 } });
    expect((await agent.post('/api/v1/dev/jobs/notification-dispatch/run').set(H).send({})).body.data.status).toBe('SUCCEEDED');
    expect((await agent.post('/api/v1/dev/jobs/membership-expiry/run').set(H).send({})).status).toBe(200); // Group 1 job, now in the same table
    expect((await agent.post('/api/v1/dev/jobs/no-such-job/run').set(H).send({})).status).toBe(404);
    expect((await agent.post('/api/v1/dev/jobs/reservation-expiry/run').set(H).send({ asOf: 'yesterday' })).status).toBe(400);
    expect((await request(ctx.app).post('/api/v1/dev/jobs/reservation-expiry/run').set(H).send({})).status).toBe(401);
  });

  it('dev tools disabled → 404 for jobs and outbox', async () => {
    const prod = buildTestContext({ configOverrides: { DEV_TOOLS_ENABLED: 'false' } });
    try {
      const agent = await prod.signIn((await makeUser(prod.db)).id);
      expect((await agent.post('/api/v1/dev/jobs/reservation-expiry/run').set(H).send({})).status).toBe(404);
      expect((await agent.get('/api/v1/dev/outbox')).status).toBe(404);
    } finally {
      await prod.close();
    }
  });
});
