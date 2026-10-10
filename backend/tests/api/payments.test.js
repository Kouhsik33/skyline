import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestContext, idemKey } from '../helpers/testApp.js';
import { truncateAll } from '../helpers/testDb.js';
import { makeClub, makeMembershipPayment, makeUser } from '../fixtures/factories.js';

// LLD §4.4 payments endpoints: happy paths and every listed error.

describe('payments API (LLD §4.4)', () => {
  let ctx;
  beforeAll(() => {
    ctx = buildTestContext();
  });
  afterAll(() => ctx.close());
  beforeEach(async () => {
    await truncateAll(ctx.db);
    ctx.handlerCalls.length = 0;
  });

  const simulate = (agent, id, outcome, key = idemKey()) =>
    agent.post(`/api/v1/payments/${id}/simulate`).set('X-Requested-With', 'soms').set('Idempotency-Key', key).send({ outcome });

  describe('GET /payments/:paymentId', () => {
    it('owner gets the payment with its target', async () => {
      const { payment, user, term } = await makeMembershipPayment(ctx);
      const res = await (await ctx.signIn(user.id)).get(`/api/v1/payments/${payment.id}`);
      expect(res.status).toBe(200);
      // Merged contract (Group 1 route): camelCase payment row + target (OQ-24).
      expect(res.body.data).toMatchObject({
        id: payment.id,
        clubId: payment.club_id,
        userId: user.id,
        purpose: 'MEMBERSHIP_JOIN',
        target: { type: 'MEMBERSHIP_TERM', id: term.id },
        amountPaise: 50000,
        currency: 'INR',
        method: 'SIMULATED',
        isSimulated: true,
        status: 'INITIATED',
        reference: payment.reference,
        failureReason: null,
        createdAt: expect.any(String),
        settledAt: null,
      });
    });

    it("another user's payment is 404; a malformed id is 400; no session is 401", async () => {
      const { payment } = await makeMembershipPayment(ctx);
      const stranger = await ctx.signIn((await makeUser(ctx.db)).id);
      expect((await stranger.get(`/api/v1/payments/${payment.id}`)).body.error.code).toBe('NOT_FOUND');
      expect((await stranger.get('/api/v1/payments/not-a-uuid')).body.error.code).toBe('VALIDATION_FAILED');
      expect((await request(ctx.app).get(`/api/v1/payments/${payment.id}`)).status).toBe(401);
    });
  });

  describe('POST /payments/:paymentId/simulate [IDEM]', () => {
    it('SUCCEEDED settles, runs the handler, writes one ledger row and returns result', async () => {
      const { payment, user } = await makeMembershipPayment(ctx);
      const res = await simulate(await ctx.signIn(user.id), payment.id, 'SUCCEEDED');
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: payment.id,
        status: 'SUCCEEDED',
        purpose: 'MEMBERSHIP_JOIN',
        isSimulated: true,
        result: { membershipStatus: 'ACTIVE' }, // the real Group 1 membership handler
      });
      expect((await ctx.db('memberships').where({ user_id: user.id }).first()).status).toBe('ACTIVE');
      expect(await ctx.db('financial_transactions').where({ payment_id: payment.id, category: 'MEMBERSHIP_DUES' })).toHaveLength(1);
    });

    it('FAILED settles with onFailed and no ledger row', async () => {
      const { payment, user } = await makeMembershipPayment(ctx);
      const res = await simulate(await ctx.signIn(user.id), payment.id, 'FAILED');
      expect(res.body.data).toMatchObject({ status: 'FAILED', failureReason: 'USER_SIMULATED_FAIL', result: null });
      expect(ctx.handlerCalls).toEqual([{ purpose: 'MEMBERSHIP_JOIN', hook: 'onFailed', paymentId: payment.id, reason: 'USER_SIMULATED_FAIL' }]);
      expect((await ctx.db('memberships').where({ user_id: user.id }).first()).status).toBe('CANCELLED');
      expect(await ctx.db('financial_transactions')).toHaveLength(0);
    });

    it('PENDING: INITIATED → PENDING without side effects; PENDING → PENDING is ok; then SUCCEEDED', async () => {
      const { payment, user } = await makeMembershipPayment(ctx);
      const agent = await ctx.signIn(user.id);
      const p1 = await simulate(agent, payment.id, 'PENDING');
      expect(p1.body.data).toMatchObject({ status: 'PENDING', settledAt: null, result: null });
      const p2 = await simulate(agent, payment.id, 'PENDING');
      expect(p2.status).toBe(200);
      expect(p2.body.data.status).toBe('PENDING');
      expect(ctx.handlerCalls).toHaveLength(0);
      const done = await simulate(agent, payment.id, 'SUCCEEDED');
      expect(done.body.data.status).toBe('SUCCEEDED');
      expect(ctx.handlerCalls).toHaveLength(1);
    });

    it('terminal payment: returned unchanged, no side effect (idempotent)', async () => {
      const { payment, user } = await makeMembershipPayment(ctx);
      const agent = await ctx.signIn(user.id);
      await simulate(agent, payment.id, 'FAILED').expect(200);
      for (const outcome of ['SUCCEEDED', 'PENDING', 'FAILED']) {
        const res = await simulate(agent, payment.id, outcome);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ status: 'FAILED', result: null });
      }
      expect(ctx.handlerCalls).toHaveLength(1);
      expect(await ctx.db('financial_transactions')).toHaveLength(0);
    });

    it('AutoPay payment on the owner endpoint → 403 FORBIDDEN (OQ-31)', async () => {
      const { payment, user } = await makeMembershipPayment(ctx, { method: 'SIMULATED_AUTOPAY' });
      const res = await simulate(await ctx.signIn(user.id), payment.id, 'SUCCEEDED');
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', details: { reason: 'AUTOPAY_PAYMENT' } });
      expect((await ctx.db('payments').where({ id: payment.id }).first()).status).toBe('INITIATED');
    });

    it("another user's payment → 404, nothing changes", async () => {
      const { payment } = await makeMembershipPayment(ctx);
      const res = await simulate(await ctx.signIn((await makeUser(ctx.db)).id), payment.id, 'SUCCEEDED');
      expect(res.status).toBe(404);
      expect((await ctx.db('payments').where({ id: payment.id }).first()).status).toBe('INITIATED');
    });

    it('unknown outcome, extra fields or an EXPIRED outcome → 400 VALIDATION_FAILED', async () => {
      const { payment, user } = await makeMembershipPayment(ctx);
      const agent = await ctx.signIn(user.id);
      for (const body of [{ outcome: 'EXPIRED' }, { outcome: 'SUCCEEDED', amountPaise: 1 }, {}]) {
        const res = await agent
          .post(`/api/v1/payments/${payment.id}/simulate`)
          .set('X-Requested-With', 'soms')
          .set('Idempotency-Key', idemKey())
          .send(body);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
    });

    it('client cannot set the amount, status or simulated flag — only the outcome is read', async () => {
      const { payment, user } = await makeMembershipPayment(ctx);
      const res = await (await ctx.signIn(user.id))
        .post(`/api/v1/payments/${payment.id}/simulate`)
        .set('X-Requested-With', 'soms')
        .set('Idempotency-Key', idemKey())
        .send({ outcome: 'SUCCEEDED', isSimulated: false });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /me/payments', () => {
    it('lists only my payments, newest first, with filters and pagination', async () => {
      const mine = await makeMembershipPayment(ctx);
      ctx.clock.advance({ minutes: 1 });
      const second = await makeMembershipPayment(ctx, { user: mine.user });
      await makeMembershipPayment(ctx); // someone else's
      await ctx.container.withTransaction((trx) => ctx.container.finance.payments.settle(second.payment.id, 'SUCCEEDED', trx));
      const agent = await ctx.signIn(mine.user.id);

      const all = await agent.get('/api/v1/me/payments');
      expect(all.status).toBe(200);
      expect(all.body).toMatchObject({ page: 1, pageSize: 20, total: 2 });
      expect(all.body.data.map((p) => p.id).sort()).toEqual([mine.payment.id, second.payment.id].sort());

      const succeeded = await agent.get('/api/v1/me/payments?status=SUCCEEDED');
      expect(succeeded.body.data.map((p) => p.id)).toEqual([second.payment.id]);

      const paged = await agent.get('/api/v1/me/payments?page=2&pageSize=1');
      expect(paged.body).toMatchObject({ page: 2, pageSize: 1, total: 2 });
      expect(paged.body.data).toHaveLength(1);

      expect((await agent.get('/api/v1/me/payments?pageSize=101')).status).toBe(400);
      expect((await agent.get('/api/v1/me/payments?purpose=DONATION')).status).toBe(400);
    });
  });

  describe('GET /clubs/:clubId/payments', () => {
    it('treasurer and club head see every payment of their club (all statuses), filtered by date', async () => {
      const a = await makeMembershipPayment(ctx);
      const b = await makeMembershipPayment(ctx, { club: { club: a.club, head: a.head } });
      await makeMembershipPayment(ctx); // other club
      await ctx.container.withTransaction((trx) => ctx.container.finance.payments.settle(b.payment.id, 'FAILED', trx));

      for (const viewer of [a.head, a.treasurer]) {
        const res = await (await ctx.signIn(viewer.id)).get(`/api/v1/clubs/${a.club.id}/payments`);
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(2);
        expect(res.body.data.map((p) => p.status).sort()).toEqual(['FAILED', 'INITIATED']);
      }

      const today = ctx.clock.todayIST();
      const agent = await ctx.signIn(a.treasurer.id);
      expect((await agent.get(`/api/v1/clubs/${a.club.id}/payments?from=${today}&to=${today}`)).body.total).toBe(2);
      expect((await agent.get(`/api/v1/clubs/${a.club.id}/payments?from=2000-01-01&to=2000-01-02`)).body.total).toBe(0);
      expect((await agent.get(`/api/v1/clubs/${a.club.id}/payments?status=FAILED`)).body.total).toBe(1);
      expect((await agent.get(`/api/v1/clubs/${a.club.id}/payments?from=2026-12-01&to=2026-11-01`)).status).toBe(400);
      expect((await agent.get(`/api/v1/clubs/${a.club.id}/payments?from=01-11-2026`)).status).toBe(400);
    });
  });

  describe('POST /dev/payments/:paymentId/simulate (dev tools)', () => {
    it('resolves an AutoPay payment of any user when dev tools are on', async () => {
      const { payment } = await makeMembershipPayment(ctx, { method: 'SIMULATED_AUTOPAY' });
      const devUser = await ctx.signIn((await makeUser(ctx.db)).id);
      const res = await devUser.post(`/api/v1/dev/payments/${payment.id}/simulate`).set('X-Requested-With', 'soms').send({ outcome: 'SUCCEEDED' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('SUCCEEDED');
    });

    it('is a plain 404 when dev tools are disabled', async () => {
      const prodLike = buildTestContext({ configOverrides: { DEV_TOOLS_ENABLED: 'false' } });
      try {
        const { payment, user } = await makeMembershipPayment(prodLike);
        const res = await (await prodLike.signIn(user.id))
          .post(`/api/v1/dev/payments/${payment.id}/simulate`)
          .set('X-Requested-With', 'soms')
          .send({ outcome: 'SUCCEEDED' });
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      } finally {
        await prodLike.close();
      }
    });
  });

  it('a deactivated user is signed out (401)', async () => {
    const { club } = await makeClub(ctx.db);
    const user = await makeUser(ctx.db);
    const agent = await ctx.signIn(user.id);
    await ctx.db('users').where({ id: user.id }).update({ is_active: false });
    expect((await agent.get('/api/v1/me/payments')).status).toBe(401);
    expect(club.id).toBeTruthy();
  });
});
