import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestContext } from '../helpers/testApp.js';
import { truncateAll } from '../helpers/testDb.js';
import { makeClub, makeMembershipPayment, makeProduct, makeUser } from '../fixtures/factories.js';
import { placeOrder } from '../helpers/merch.js';

// A2 — migration 014 (payments): FK order_id → orders; one live payment (INITIATED or PENDING)
// per order, booking and membership term; constraint names the error mapper turns into
// PAYMENT_ALREADY_PENDING. Migration 015: a published announcement cannot be deleted.

describe('payments constraints (migration 014)', () => {
  let ctx;
  beforeAll(() => {
    ctx = buildTestContext();
  });
  afterAll(() => ctx.close());
  beforeEach(() => truncateAll(ctx.db));

  const rawPayment = (club, user, target, status = 'INITIATED') =>
    ctx.db('payments').insert({ club_id: club.id, user_id: user.id, purpose: target.purpose, membership_term_id: target.termId ?? null, booking_id: target.bookingId ?? null, order_id: target.orderId ?? null, amount_paise: 1000, method: 'SIMULATED', status, reference: `SIM-${crypto.randomUUID()}` });

  it('order_id is a foreign key to orders', async () => {
    const { club } = await makeClub(ctx.db);
    const user = await makeUser(ctx.db);
    await expect(rawPayment(club, user, { purpose: 'MERCH_ORDER', orderId: crypto.randomUUID() })).rejects.toThrow(/payments_order_id_fkey/);
  });

  it('one live payment per order: a second INITIATED/PENDING violates payments_live_order_uq', async () => {
    const c = await makeClub(ctx.db);
    const buyer = await makeUser(ctx.db);
    const { variants } = await makeProduct(ctx.db, c, { pricePaise: 1000 });
    const placed = (await placeOrder(await ctx.signIn(buyer.id), c.club.id, [{ variantId: variants.M.id, quantity: 1 }], 1000)).body.data;
    await expect(rawPayment(c.club, buyer, { purpose: 'MERCH_ORDER', orderId: placed.order.id })).rejects.toMatchObject({ code: '23505', constraint: 'payments_live_order_uq' });
    await ctx.db('payments').where({ id: placed.payment.id }).update({ status: 'PENDING' });
    await expect(rawPayment(c.club, buyer, { purpose: 'MERCH_ORDER', orderId: placed.order.id })).rejects.toMatchObject({ constraint: 'payments_live_order_uq' });
    // a FAILED attempt frees the order for a new live payment
    await ctx.db('payments').where({ id: placed.payment.id }).update({ status: 'FAILED' });
    await expect(rawPayment(c.club, buyer, { purpose: 'MERCH_ORDER', orderId: placed.order.id })).resolves.toBeDefined();
  });

  it('one live payment per membership term; through the service it is PAYMENT_ALREADY_PENDING', async () => {
    const { payment, club, user } = await makeMembershipPayment(ctx);
    const again = ctx.container.withTransaction((trx) =>
      ctx.container.finance.payments.create(trx, { clubId: club.id, userId: user.id, purpose: 'MEMBERSHIP_JOIN', membershipTermId: payment.membership_term_id, amountPaise: 50000 }),
    );
    await expect(again).rejects.toMatchObject({ code: 'PAYMENT_ALREADY_PENDING', httpStatus: 409 });
  });

  it('the indexes exist with the names the error mapper knows', async () => {
    const { rows } = await ctx.db.raw(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'payments' AND indexname LIKE 'payments_%_uq' ORDER BY 1`);
    expect(rows.map((r) => r.indexname)).toEqual(['payments_live_booking_uq', 'payments_live_membership_term_uq', 'payments_live_order_uq', 'payments_succeeded_order_uq']);
    for (const r of rows.filter((x) => x.indexname.includes('_live_'))) expect(r.indexdef).toMatch(/'INITIATED'.*'PENDING'/);
    const { UNIQUE_VIOLATION_CODES } = await import('../../src/shared/middleware/errorHandler.js');
    for (const r of rows) expect(UNIQUE_VIOLATION_CODES[r.indexname]).toBe('PAYMENT_ALREADY_PENDING');
  });

  it('migration 015: a PUBLISHED announcement cannot be deleted; a DRAFT can', async () => {
    const { club, head } = await makeClub(ctx.db);
    const base = { club_id: club.id, title: 'T', body: 'B', category: 'GENERAL', audience: 'PUBLIC', created_by: head.id };
    const [pub] = await ctx.db('announcements').insert({ ...base, status: 'PUBLISHED', published_by: head.id, published_at: new Date() }).returning('id');
    const [draft] = await ctx.db('announcements').insert({ ...base, status: 'DRAFT' }).returning('id');
    await expect(ctx.db('announcements').where({ id: pub.id }).del()).rejects.toThrow(/published announcements are immutable/);
    await ctx.db('announcements').where({ id: draft.id }).del();
  });
});

describe('seeds load after migration 014 and are idempotent', () => {
  let ctx;
  beforeAll(() => {
    ctx = buildTestContext();
  });
  afterAll(() => ctx.close());

  it('010 + 020 twice → identical row counts; the INITIATED payment and ledger are present', async () => {
    await truncateAll(ctx.db);
    const g1 = await import('../../src/db/seeds/010_group1_seed.js');
    const g2 = await import('../../src/db/seeds/020_group2_seed.js');
    const counts = async () => {
      const out = {};
      for (const t of ['users', 'clubs', 'memberships', 'events', 'products', 'product_variants', 'orders', 'payments', 'fundraisers', 'expenses', 'financial_transactions', 'stock_movements']) {
        out[t] = Number((await ctx.db(t).count({ n: '*' }))[0].n);
      }
      return out;
    };
    await g1.seed(ctx.db);
    await g2.seed(ctx.db);
    const first = await counts();
    await g1.seed(ctx.db);
    await g2.seed(ctx.db);
    expect(await counts()).toEqual(first);
    expect(first).toMatchObject({ users: 6, clubs: 1, payments: 3, financial_transactions: 5, orders: 2 });
    expect(await ctx.db('payments').where({ status: 'INITIATED' })).toHaveLength(1);
  }, 60000);
});
