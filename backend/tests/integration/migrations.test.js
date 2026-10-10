import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import knexFactory from 'knex';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const MIGRATIONS = readdirSync(path.resolve('src/db/migrations')).filter((f) => /^\d{3}_.+\.js$/.test(f)).length;
import { createAdminDb, createTestDb, migrateLatest, rollbackAll, testDatabaseUrl } from '../helpers/testDb.js';

// T-13 acceptance: migrate:latest and rollback succeed on a fresh database (all real migrations).
// Runs against a scratch database so the shared soms_test schema is untouched.

const SCRATCH = 'soms_migration_check_test';

async function tables(db) {
  const { rows } = await db.raw(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE 'knex_migrations%' ORDER BY 1`,
  );
  return rows.map((r) => r.tablename);
}

describe('migrations up/down (T-13)', () => {
  let admin;
  let scratch;

  beforeAll(async () => {
    admin = createAdminDb();
    await admin.raw(`DROP DATABASE IF EXISTS ${SCRATCH}`);
    await admin.raw(`CREATE DATABASE ${SCRATCH}`);
    const url = new URL(testDatabaseUrl());
    url.pathname = `/${SCRATCH}`;
    scratch = knexFactory({ client: 'pg', connection: url.toString(), pool: { min: 0, max: 2 } });
  });

  afterAll(async () => {
    await scratch?.destroy();
    await admin.raw(`DROP DATABASE IF EXISTS ${SCRATCH}`);
    await admin.destroy();
  });

  it('latest → rollback all → latest again, on a fresh database', async () => {
    const [, applied] = await migrateLatest(scratch);
    expect(applied).toHaveLength(MIGRATIONS);
    const afterUp = await tables(scratch);
    for (const t of ['audit_logs', 'idempotency_keys', 'job_runs', 'uploaded_files', 'payments', 'financial_transactions', 'expenses', 'budgets', 'orders', 'fundraisers', 'users', 'clubs']) {
      expect(afterUp).toContain(t);
    }

    const [, rolledBack] = await rollbackAll(scratch);
    expect(rolledBack).toHaveLength(MIGRATIONS);
    expect(await tables(scratch)).toEqual([]);
    const { rows: fns } = await scratch.raw(
      `SELECT proname FROM pg_proc WHERE proname IN ('set_updated_at', 'forbid_update_delete')`,
    );
    expect(fns).toEqual([]);

    const [, reapplied] = await migrateLatest(scratch);
    expect(reapplied).toHaveLength(MIGRATIONS);
  });
});

describe('schema invariants on soms_test', () => {
  let db;
  beforeAll(() => {
    db = createTestDb({ poolMax: 2 });
  });
  afterAll(() => db.destroy());

  it('every *_paise column is BIGINT (no float money)', async () => {
    const { rows } = await db.raw(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name LIKE '%\\_paise'`,
    );
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.filter((r) => r.data_type !== 'bigint')).toEqual([]);
  });

  it('append-only triggers are installed on audit_logs, financial_transactions and stock_movements', async () => {
    const { rows } = await db.raw(
      `SELECT event_object_table AS t, string_agg(DISTINCT event_manipulation, ',' ORDER BY event_manipulation) AS ops
         FROM information_schema.triggers
        WHERE action_statement LIKE '%forbid_update_delete%'
        GROUP BY 1 ORDER BY 1`,
    );
    expect(rows).toEqual([
      { t: 'audit_logs', ops: 'DELETE,UPDATE' },
      { t: 'financial_transactions', ops: 'DELETE,UPDATE' },
      { t: 'stock_movements', ops: 'DELETE,UPDATE' },
    ]);
  });
});
