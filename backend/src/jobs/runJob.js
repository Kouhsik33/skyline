// runJob(name, runKey, fn) — LLD §7.
//   1. pg_try_advisory_lock(hashtext(name)) on one dedicated connection; busy -> SKIPPED_LOCKED.
//   2. Daily jobs (runKey = 'YYYY-MM-DD'): INSERT job_runs … ON CONFLICT DO NOTHING; an existing
//      SUCCEEDED/RUNNING row -> ALREADY_RAN. A FAILED row is retaken (OQ-56).
//      Minute jobs (runKey null) keep no job_runs row.
//   3. Run fn(); record SUCCEEDED + summary or FAILED + error; unlock on the same connection.
// Failures are logged and recorded, and returned to the caller; they never escape a cron tick.

export function createJobRunner({ db, clock, logger }) {
  async function claimRun(name, runKey) {
    const now = clock.now();
    const { rows } = await db.raw(
      `INSERT INTO job_runs (job_name, run_key, status, started_at) VALUES (?, ?, 'RUNNING', ?)
       ON CONFLICT (job_name, run_key) DO NOTHING RETURNING id`,
      [name, runKey, now],
    );
    if (rows.length) return rows[0].id;
    const retaken = await db('job_runs')
      .where({ job_name: name, run_key: runKey, status: 'FAILED' })
      .update({ status: 'RUNNING', started_at: now, finished_at: null, error: null }, ['id']);
    return retaken[0]?.id ?? null;
  }

  return async function runJob(name, runKey, fn) {
    const conn = await db.client.acquireConnection();
    try {
      const { rows } = await conn.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [name]);
      if (!rows[0].locked) return { job: name, runKey, status: 'SKIPPED_LOCKED' };
      try {
        const runId = runKey ? await claimRun(name, runKey) : null;
        if (runKey && !runId) return { job: name, runKey, status: 'ALREADY_RAN' };
        try {
          const summary = (await fn()) ?? {};
          if (runId) await db('job_runs').where({ id: runId }).update({ status: 'SUCCEEDED', finished_at: clock.now(), summary: JSON.stringify(summary) });
          logger.info({ job: name, runKey, summary }, 'job succeeded');
          return { job: name, runKey, status: 'SUCCEEDED', summary };
        } catch (err) {
          if (runId) await db('job_runs').where({ id: runId }).update({ status: 'FAILED', finished_at: clock.now(), error: String(err?.message ?? err) });
          logger.error({ job: name, runKey, err }, 'job failed');
          return { job: name, runKey, status: 'FAILED', error: String(err?.message ?? err) };
        }
      } finally {
        await conn.query('SELECT pg_advisory_unlock(hashtext($1))', [name]);
      }
    } finally {
      await db.client.releaseConnection(conn);
    }
  };
}
