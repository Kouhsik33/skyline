import { afterAll, beforeAll, describe } from 'vitest';
import { createTestDb } from '../helpers/testDb.js';
import { createGroup1Bridge } from '../../src/integration/group1Bridge.js';
import { group1TrxContract } from './group1Trx.contract.js';

// OQ-59 contract (see group1Trx.contract.js), run against the REAL Group 1 implementation that
// Group 2 calls at runtime: src/integration/group1Bridge.js (auth.getUser, clubs.listRoleHolders).
// `npm run test:contract:group1` runs only this file.

describe('OQ-59 Group 1 { trx } contract — real Group 1 bridge (src/integration/group1Bridge.js)', () => {
  let db;
  beforeAll(() => {
    db = createTestDb({ poolMax: 1 });
  });
  afterAll(() => db.destroy());

  group1TrxContract({ getDb: () => db, impl: (conn) => createGroup1Bridge({ db: conn, authRepository: null, authz: null }) });
});
