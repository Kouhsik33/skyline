import knex from 'knex';
import knexConfig from '../../knexfile.js';

// Test database helpers shared by both groups. soms_test is rebuilt once per run (globalSetup)
// with the real migrations; tests truncate between files.

let testDb;

export function getTestDb() {
  if (!testDb) testDb = knex(knexConfig.test);
  return testDb;
}

export async function migrateTestDb() {
  await getTestDb().migrate.latest();
}

/** Truncate mutable tables between test files (keeps schema). */
export async function truncateTestDb() {
  await truncateAll(getTestDb());
}

export async function resetTestDb() {
  const db = getTestDb();
  await db.migrate.rollback(undefined, true);
  await db.migrate.latest();
}

export async function destroyTestDb() {
  if (testDb) {
    await testDb.destroy();
    testDb = null;
  }
}

// ---- Group 2 helpers -----------------------------------------------------------------------

export function testDatabaseUrl() {
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (see docker-compose.yml)');
  if (!/_test(\?|$)/.test(url)) throw new Error('Refusing to run tests against a database whose name does not end in _test');
  return url;
}

/** A separate pool on the test database (e.g. poolMax 1 for the { trx } contract). */
export function createTestDb({ url = testDatabaseUrl(), poolMax = 30 } = {}) {
  return knex({ ...knexConfig.test, connection: url, pool: { min: 0, max: poolMax } });
}

export async function resetSchema(db) {
  await db.raw('DROP SCHEMA IF EXISTS public CASCADE');
  await db.raw('CREATE SCHEMA public');
}

export const migrateLatest = (db) => db.migrate.latest(knexConfig.test.migrations);
export const rollbackAll = (db) => db.migrate.rollback(knexConfig.test.migrations, true);

export async function truncateAll(db) {
  const { rows } = await db.raw(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE 'knex_migrations%'`,
  );
  if (!rows.length) return;
  // TRUNCATE does not fire the row-level append-only triggers.
  await db.raw(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

/** Admin connection to the maintenance database, for creating scratch databases. */
export function createAdminDb(url = testDatabaseUrl()) {
  const admin = new URL(url);
  admin.pathname = '/postgres';
  return knex({ client: 'pg', connection: admin.toString(), pool: { min: 0, max: 1 } });
}
