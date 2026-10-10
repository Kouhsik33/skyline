import knex from 'knex';
import pg from 'pg';
import knexConfig from '../../knexfile.js';
import { config } from '../config/index.js';

// BIGINT (int8, OID 20) holds paise: parse to a JS number, refusing values beyond
// Number.MAX_SAFE_INTEGER instead of silently losing precision (ADR-008).
pg.types.setTypeParser(20, (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`bigint ${value} exceeds Number.MAX_SAFE_INTEGER`);
  return n;
});
// DATE (OID 1082) stays 'YYYY-MM-DD': business dates are IST calendar dates, not instants (LLD conventions).
pg.types.setTypeParser(1082, (value) => value);

const env = config.isTest ? 'test' : config.NODE_ENV === 'production' ? 'production' : 'development';

export const db = knex(knexConfig[env] || knexConfig.development);
