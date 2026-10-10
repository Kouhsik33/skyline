import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/testApp.js';
import { getTestDb, migrateTestDb, truncateTestDb } from '../helpers/testDb.js';
import { createUser } from '../helpers/factories.js';

// B5/B6 backend side: logout destroys the server session AND clears the cookie; a second login in
// the same browser gets a new session id and sees only its own data; API responses are not cached;
// cookie flags work over local HTTP (HttpOnly, SameSite=Lax, not Secure in dev/test).

const H = { 'X-Requested-With': 'soms' };
const sidOf = (res) => (res.headers['set-cookie'] || []).find((c) => c.startsWith('sid='));

describe('session lifecycle (B5, B6)', () => {
  let app;
  let db;
  let a;
  let b;
  beforeAll(async () => {
    await migrateTestDb();
    await truncateTestDb();
    db = getTestDb();
    ({ app } = createTestApp());
    a = await createUser(db, { fullName: 'First User' });
    b = await createUser(db, { fullName: 'Second User' });
  });

  const login = (agent, user) => agent.post('/api/v1/auth/login').set(H).send({ email: user.email, password: 'TestPass123!' });

  it('login sets an HttpOnly, SameSite=Lax session cookie that works over plain HTTP', async () => {
    const res = await login(request.agent(app), a);
    expect(res.status).toBe(200);
    const cookie = sidOf(res);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toMatch(/;\s*Secure/i);
  });

  it('logout destroys the server session and clears the cookie; the old cookie no longer works', async () => {
    const agent = request.agent(app);
    const loginRes = await login(agent, a);
    const oldCookie = sidOf(loginRes).split(';')[0];
    expect((await agent.get('/api/v1/auth/me')).status).toBe(200);
    const sessionsBefore = Number((await db('user_sessions').count({ n: '*' }))[0].n);

    const out = await agent.post('/api/v1/auth/logout').set(H);
    expect(out.status).toBe(204);
    const cleared = sidOf(out);
    expect(cleared).toBeTruthy();
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/i);
    expect(Number((await db('user_sessions').count({ n: '*' }))[0].n)).toBe(sessionsBefore - 1);

    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', oldCookie)).status).toBe(401); // replayed old cookie
  });

  it('logging in as a second user in the same browser: new session id, only the second user’s data', async () => {
    const agent = request.agent(app);
    const first = sidOf(await login(agent, a)).split(';')[0];
    await agent.post('/api/v1/auth/logout').set(H);
    const second = sidOf(await login(agent, b)).split(';')[0];
    expect(second).not.toBe(first);
    const me = await agent.get('/api/v1/auth/me');
    expect(me.body.data.user).toMatchObject({ id: b.id, fullName: 'Second User' });
    expect(JSON.stringify(me.body)).not.toContain(a.id);
  });

  it('switching user WITHOUT logout also replaces the identity (session regenerated)', async () => {
    const agent = request.agent(app);
    await login(agent, a);
    await login(agent, b);
    expect((await agent.get('/api/v1/auth/me')).body.data.user.id).toBe(b.id);
  });

  it('API responses are never cached by the browser (Back after logout cannot replay data)', async () => {
    const agent = request.agent(app);
    await login(agent, a);
    for (const path of ['/api/v1/auth/me', '/api/v1/me/payments', '/api/v1/clubs']) {
      const res = await agent.get(path);
      expect(res.headers['cache-control'], path).toMatch(/no-store/);
    }
  });
});
