import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestContext, idemKey } from '../helpers/testApp.js';
import { truncateAll } from '../helpers/testDb.js';
import { makeMembershipPayment, makeUser } from '../fixtures/factories.js';

// TC-PAY-02 — Idempotency-Key replay (LLD §3.1, §4.0; OQ-23), on the [IDEM] simulate endpoint.

describe('Idempotency-Key (TC-PAY-02)', () => {
  let ctx;
  beforeAll(() => {
    ctx = buildTestContext();
  });
  afterAll(() => ctx.close());
  beforeEach(async () => {
    await truncateAll(ctx.db);
    ctx.handlerCalls.length = 0;
  });

  const simulate = (agent, paymentId, body, key) => {
    const req = agent.post(`/api/v1/payments/${paymentId}/simulate`).set('X-Requested-With', 'soms');
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.send(body);
  };

  it('replay returns the stored response; side effects happen once', async () => {
    const { payment, user } = await makeMembershipPayment(ctx);
    const agent = await ctx.signIn(user.id);
    const key = idemKey();
    const first = await simulate(agent, payment.id, { outcome: 'SUCCEEDED' }, key);
    expect(first.status).toBe(200);
    expect(first.body.data.result).toMatchObject({ membershipStatus: 'ACTIVE' }); // real handler

    ctx.clock.advance({ minutes: 5 });
    const replay = await simulate(agent, payment.id, { outcome: 'SUCCEEDED' }, key);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(ctx.handlerCalls).toHaveLength(1);
    expect(await ctx.db('financial_transactions').count({ n: '*' }).first()).toEqual({ n: 1 });
  });

  it('a new key on a settled payment returns current state (no side effect) — not a replay', async () => {
    const { payment, user } = await makeMembershipPayment(ctx);
    const agent = await ctx.signIn(user.id);
    await simulate(agent, payment.id, { outcome: 'SUCCEEDED' }, idemKey()).expect(200);
    const other = await simulate(agent, payment.id, { outcome: 'FAILED' }, idemKey());
    expect(other.status).toBe(200);
    expect(other.body.data).toMatchObject({ status: 'SUCCEEDED', result: null });
    expect(other.headers['idempotent-replayed']).toBeUndefined();
    expect(ctx.handlerCalls).toHaveLength(1);
  });

  it('same key, different body → 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const { payment, user } = await makeMembershipPayment(ctx);
    const agent = await ctx.signIn(user.id);
    const key = idemKey();
    await simulate(agent, payment.id, { outcome: 'PENDING' }, key).expect(200);
    const res = await simulate(agent, payment.id, { outcome: 'SUCCEEDED' }, key);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('same key on a different path → 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const a = await makeMembershipPayment(ctx);
    const b = await makeMembershipPayment(ctx, { user: a.user });
    const agent = await ctx.signIn(a.user.id);
    const key = idemKey();
    await simulate(agent, a.payment.id, { outcome: 'PENDING' }, key).expect(200);
    const res = await simulate(agent, b.payment.id, { outcome: 'PENDING' }, key);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('missing or non-UUID key → 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
    const { payment, user } = await makeMembershipPayment(ctx);
    const agent = await ctx.signIn(user.id);
    expect((await simulate(agent, payment.id, { outcome: 'SUCCEEDED' })).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await simulate(agent, payment.id, { outcome: 'SUCCEEDED' }, 'abc')).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await ctx.db('payments').where({ id: payment.id }).first()).status).toBe('INITIATED');
  });

  it('4xx responses are stored and replayed too', async () => {
    const { payment, user } = await makeMembershipPayment(ctx);
    const agent = await ctx.signIn(user.id);
    const key = idemKey();
    const bad = await simulate(agent, payment.id, { outcome: 'REFUNDED' }, key);
    expect(bad.status).toBe(400);
    const replay = await simulate(agent, payment.id, { outcome: 'REFUNDED' }, key);
    expect(replay.status).toBe(400);
    expect(replay.body).toEqual(bad.body);
    expect(replay.headers['idempotent-replayed']).toBe('true');
  });

  it('a key still in progress → 409 REQUEST_IN_PROGRESS; a lock older than 60 s is retaken', async () => {
    const { payment, user } = await makeMembershipPayment(ctx);
    const agent = await ctx.signIn(user.id);
    const key = idemKey();
    const path = `/api/v1/payments/${payment.id}/simulate`;
    const { requestHash } = await import('../../src/shared/middleware/idempotencyG2.js');
    await ctx.db('idempotency_keys').insert({
      user_id: user.id,
      key,
      method: 'POST',
      path,
      request_hash: requestHash('POST', path, { outcome: 'SUCCEEDED' }),
      locked_at: ctx.clock.now(),
      expires_at: new Date(ctx.clock.now().getTime() + 86400000),
    });
    const busy = await simulate(agent, payment.id, { outcome: 'SUCCEEDED' }, key);
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('REQUEST_IN_PROGRESS');

    ctx.clock.advance({ minutes: 2 });
    const retaken = await simulate(agent, payment.id, { outcome: 'SUCCEEDED' }, key);
    expect(retaken.status).toBe(200);
    expect(retaken.body.data.status).toBe('SUCCEEDED');
  });

  it('keys are per user: the same key from another user is independent', async () => {
    const a = await makeMembershipPayment(ctx);
    const b = await makeMembershipPayment(ctx);
    const key = idemKey();
    await simulate(await ctx.signIn(a.user.id), a.payment.id, { outcome: 'SUCCEEDED' }, key).expect(200);
    const res = await simulate(await ctx.signIn(b.user.id), b.payment.id, { outcome: 'SUCCEEDED' }, key);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(b.payment.id);
  });

  it('an expired key (24 h) can be reused', async () => {
    const { payment, user } = await makeMembershipPayment(ctx);
    const agent = await ctx.signIn(user.id);
    const key = idemKey();
    await simulate(agent, payment.id, { outcome: 'PENDING' }, key).expect(200);
    ctx.clock.advance({ hours: 25 });
    const res = await simulate(agent, payment.id, { outcome: 'SUCCEEDED' }, key);
    expect(res.status).toBe(200);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    expect(res.body.data.status).toBe('SUCCEEDED');
  });

  it('a 5xx response releases the key so the client can retry', async () => {
    const failing = buildTestContext({ handlerOptions: { failOn: 'onSucceeded' } });
    try {
      const { payment, user } = await makeMembershipPayment(failing);
      const agent = await failing.signIn(user.id);
      const key = idemKey();
      const res = await simulate(agent, payment.id, { outcome: 'SUCCEEDED' }, key);
      expect(res.status).toBe(500);
      expect(await failing.db('idempotency_keys').where({ user_id: user.id, key }).first()).toBeUndefined();
    } finally {
      await failing.close();
    }
  });

  it('unauthenticated [IDEM] call is 401 before any key is stored', async () => {
    const user = await makeUser(ctx.db);
    const { default: request } = await import('supertest');
    const res = await request(ctx.app)
      .post(`/api/v1/payments/${crypto.randomUUID()}/simulate`)
      .set('X-Requested-With', 'soms')
      .set('Idempotency-Key', idemKey())
      .send({ outcome: 'SUCCEEDED' });
    expect(res.status).toBe(401);
    expect(await ctx.db('idempotency_keys').where({ user_id: user.id }).first()).toBeUndefined();
  });
});
