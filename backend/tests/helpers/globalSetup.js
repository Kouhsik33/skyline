import knex from 'knex';
import knexConfig from '../../knexfile.js';

// Once per `vitest run`: fresh public schema on soms_test, then every real migration.
export default async function setup() {
  if (process.env.SKIP_DB_SETUP === '1') return; // `npm run lint:money` needs no database
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !/_test(\?|$)/.test(url)) throw new Error('globalSetup: TEST_DATABASE_URL must point at a *_test database');
  const db = knex({ ...knexConfig.test, connection: url, pool: { min: 0, max: 2 } });
  try {
    await db.raw('DROP SCHEMA IF EXISTS public CASCADE');
    await db.raw('CREATE SCHEMA public');
    await db.migrate.latest(knexConfig.test.migrations);
  } finally {
    await db.destroy();
  }
}
