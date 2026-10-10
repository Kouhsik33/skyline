import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/testApp.js';
import { getTestDb, migrateTestDb, truncateTestDb } from '../helpers/testDb.js';
import { createClub } from '../helpers/factories.js';

// A1 on real routes: a Group 1 route with a query schema (GET /clubs) used to 500 because the old
// validate() assigned req.query (Express 5 getter). It must now parse and paginate.
describe('A1: query-validated routes of both groups', () => {
  let app;
  beforeAll(async () => {
    await migrateTestDb();
    await truncateTestDb();
    ({ app } = createTestApp());
    const db = getTestDb();
    for (let i = 0; i < 3; i += 1) await createClub(db, { name: `Club ${i}` });
  });

  it('Group 1: GET /clubs?page=1&pageSize=2 → 200 with the parsed page size applied', async () => {
    const res = await request(app).get('/api/v1/clubs?page=1&pageSize=2');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(2);
  });

  it('Group 1: invalid query → 400 VALIDATION_FAILED, not 500', async () => {
    const res = await request(app).get('/api/v1/clubs?pageSize=abc');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('Group 2: GET /clubs/:clubId/products?all=false (public, query schema) → 200', async () => {
    const club = await getTestDb()('clubs').first();
    const res = await request(app).get(`/api/v1/clubs/${club.id}/products?all=false`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});
