import knex from 'knex';
import pg from 'pg';
import knexConfig from '../../knexfile.js';
import { config } from '../config/index.js';

// Restored from Group 2's original db setup (dropped when the groups were merged); its finance,
// merchandise and fundraiser code relies on both.
// BIGINT (int8, OID 20) holds paise. Parse to a JS number, refusing anything outside the
// safe-integer range instead of silently losing precision.
pg.types.setTypeParser(20, (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`bigint ${value} exceeds Number.MAX_SAFE_INTEGER`);
  return n;
});
// DATE (OID 1082) stays a 'YYYY-MM-DD' string: business dates are IST calendar dates, not instants.
pg.types.setTypeParser(1082, (value) => value);

const env = config.isTest ? 'test' : config.NODE_ENV === 'production' ? 'production' : 'development';

export const db = knex(knexConfig[env] || knexConfig.development);
