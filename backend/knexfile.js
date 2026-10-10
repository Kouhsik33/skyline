import './loadEnv.js';

const shared = {
  client: 'pg',
  pool: { min: 0, max: Number(process.env.DATABASE_POOL_MAX ?? 10) },
  migrations: {
    directory: './src/db/migrations',
    tableName: 'knex_migrations',
  },
  seeds: {
    directory: './src/db/seeds',
  },
};

export default {
  development: {
    ...shared,
    connection: process.env.DATABASE_URL,
  },
  test: {
    ...shared,
    connection: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL,
  },
  production: {
    ...shared,
    connection: process.env.DATABASE_URL,
  },
};
