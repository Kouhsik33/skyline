import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestContext, idemKey } from '../helpers/testApp.js';
import { truncateAll } from '../helpers/testDb.js';
import { pay, placeOrder, variantRow } from '../helpers/merch.js';
import { makeActiveMember, makeClub, makeProduct, makeUser } from '../fixtures/factories.js';

// T-62 orders and T-63 pickup (LLD §4.7, §5.9). TC-MER-01, TC-MER-03, TC-MER-06.

const H = { 'X-Requested-With': 'soms' };

describe('orders (T-62)', () => {
  let ctx;
  let club;
  let other;
  let buyerUser;
  let buyer;
  beforeAll(() => {
    ctx = buildTestContext();
  });
  afterAll(() => ctx.close());
  beforeEach(async () => {
    await truncateAll(ctx.db);
    club = await makeClub(ctx.db);
    other = await makeClub(ctx.db);
    buyerUser = await makeUser(ctx.db, { fullName: 'Buyer' });
    buyer = await ctx.signIn(buyerUser.id);
  });

  it('TC-MER-01: size-specific inventory — L out of stock, M fine, other sizes untouched', async () => {
    const { variants } = await makeProduct(ctx.db, club, { pricePaise: 50000, variants: [{ size: 'M', stock: 5 }, { size: 'L', stock: 0 }, { size: 'S', stock: 4 }] });
    const l = await placeOrder(buyer, club.club.id, [{ variantId: variants.L.id, quantity: 1 }], 50000);
    expect(l.status).toBe(409);
    expect(l.body.error).toMatchObject({ code: 'OUT_OF_STOCK', details: { variantId: variants.L.id, available: 0 } });
    const m = await placeOrder(buyer, club.club.id, [{ variantId: variants.M.id, quantity: 2 }], 100000);
    expect(m.status).toBe(201);
    expect((await variantRow(ctx.db, variants.M.id)).stock_reserved).toBe(2);
    expect((await variantRow(ctx.db, variants.S.id))).toMatchObject({ stock_on_hand: 4, stock_reserved: 0 });
    expect((await variantRow(ctx.db, variants.L.id))).toMatchObject({ stock_on_hand: 0, stock_reserved: 0 });
  });

  it('TC-MER-03: stock reserved at placement, decremented only on SUCCEEDED; ledger MERCH_SALE; pickup code', async () => {
    const { variants } = await makeProduct(ctx.db, club, { pricePaise: 40000, variants: [{ size: 'M', stock: 5 }] });
    const id = variants.M.id;
    const placed = await placeOrder(buyer, club.club.id, [{ variantId: id, quantity: 2 }], 80000);
    expect(placed.status).toBe(201);
    expect(placed.body.data.order).toMatchObject({ status: 'PENDING_PAYMENT', totalPaise: 80000, subtotalPaise: 80000, discountPaise: 0, buyerType: 'NON_MEMBER', pricingMode: 'BEST_OF', pickupCode: null });
    expect(placed.body.data.order.holdExpiresAt).toBe(new Date(ctx.clock.now().getTime() + 15 * 60_000).toISOString());
    expect(placed.body.data.payment).toMatchObject({ status: 'INITIATED', amountPaise: 80000, isSimulated: true });
    expect(await variantRow(ctx.db, id)).toMatchObject({ stock_on_hand: 5, stock_reserved: 2 });

    const paid = await pay(buyer, placed.body.data.payment.id);
    expect(paid.body.data.result).toMatchObject({ orderStatus: 'CONFIRMED', pickupCode: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{8}$/) });
    expect(await variantRow(ctx.db, id)).toMatchObject({ stock_on_hand: 3, stock_reserved: 0 });
    const moves = await ctx.db('stock_movements').where({ variant_id: id }).orderBy('created_at');
    expect(moves.map((m) => [m.type, m.quantity])).toEqual([['RESERVE', 2], ['SALE', -2]]);
    const ledger = await ctx.db('financial_transactions').where({ order_id: placed.body.data.order.id });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ category: 'MERCH_SALE', amount_paise: 80000, direction: 'IN' });

    const mine = await buyer.get(`/api/v1/me/orders/${placed.body.data.order.id}`);
    expect(mine.body.data).toMatchObject({ status: 'CONFIRMED', pickupCode: paid.body.data.result.pickupCode, payment: { status: 'SUCCEEDED' } });
    expect(mine.body.data.items[0]).toMatchObject({ sizeLabel: 'M', quantity: 2, lineTotalPaise: 80000, priceRule: 'LIST' });
    expect(mine.body.data.payments).toHaveLength(1);
  });

  it('TC-MER-03: FAILED payment releases the reservation; no ledger; order CANCELLED', async () => {
    const { variants } = await makeProduct(ctx.db, club, { pricePaise: 40000, variants: [{ size: 'M', stock: 5 }] });
    const placed = await placeOrder(buyer, club.club.id, [{ variantId: variants.M.id, quantity: 3 }], 120000);
    await pay(buyer, placed.body.data.payment.id, 'FAILED');
    expect(await variantRow(ctx.db, variants.M.id)).toMatchObject({ stock_on_hand: 5, stock_reserved: 0 });
    expect((await ctx.db('orders').where({ id: placed.body.data.order.id }).first())).toMatchObject({ status: 'CANCELLED', cancel_reason: 'USER_SIMULATED_FAIL' }); // Group 1 simulate reason
    expect(await ctx.db('financial_transactions')).toHaveLength(0);
    expect((await ctx.db('stock_movements').where({ type: 'RELEASE' }).first()).quantity).toBe(-3);
  });

  it('PRICE_CHANGED with the server quote when expectedTotalPaise is wrong; nothing reserved', async () => {
    const { variants } = await makeProduct(ctx.db, club, { pricePaise: 40000 });
    const res = await placeOrder(buyer, club.club.id, [{ variantId: variants.M.id, quantity: 1 }], 39000);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PRICE_CHANGED');
    expect(res.body.error.details.quote).toMatchObject({ totalPaise: 40000, lines: [{ variantId: variants.M.id, unitFinalPricePaise: 40000 }] });
    expect((await variantRow(ctx.db, variants.M.id)).stock_reserved).toBe(0);
    expect(await ctx.db('orders')).toHaveLength(0);
  });

  it('TOO_MANY_ITEMS above 10 lines; duplicate sizes and bad quantities are VALIDATION_FAILED', async () => {
    const sizes = Array.from({ length: 11 }, (_, i) => ({ size: `S${i}`, stock: 5 }));
    const { variants } = await makeProduct(ctx.db, club, { pricePaise: 1000, variants: sizes });
    const items = Object.values(variants).map((v) => ({ variantId: v.id, quantity: 1 }));
    const tooMany = await placeOrder(buyer, club.club.id, items, 11000);
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe('TOO_MANY_ITEMS');
    const dup = await placeOrder(buyer, club.club.id, [items[0], items[0]], 2000);
    expect(dup.body.error.code).toBe('VALIDATION_FAILED');
    expect((await placeOrder(buyer, club.club.id, [{ ...items[0], quantity: 11 }], 11000)).body.error.code).toBe('VALIDATION_FAILED');
    expect((await placeOrder(buyer, club.club.id, [{ ...items[0], quantity: 0 }], 0)).body.error.code).toBe('VALIDATION_FAILED');
  });

  it('PRODUCT_NOT_ORDERABLE for non-ACTIVE products and inactive sizes; another club’s variant is 404', async () => {
    const draft = await makeProduct(ctx.db, club, { status: 'DRAFT' });
    const inactive = await makeProduct(ctx.db, club, { status: 'INACTIVE' });
    const sizeOff = await makeProduct(ctx.db, club, { variants: [{ size: 'M', stock: 5, active: false }] });
    for (const v of [draft.variants.M, inactive.variants.M, sizeOff.variants.M]) {
      const res = await placeOrder(buyer, club.club.id, [{ variantId: v.id, quantity: 1 }], 50000);
      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({ code: 'PRODUCT_NOT_ORDERABLE', details: { variantId: v.id } });
    }
    const elsewhere = await makeProduct(ctx.db, other);
    expect((await placeOrder(buyer, club.club.id, [{ variantId: elsewhere.variants.M.id, quantity: 1 }], 50000)).status).toBe(404);
  });

  it('MEMBERS_ONLY_PRODUCT for non-members (from PricingPolicy); members order with buyerType MEMBER and their term', async () => {
    const { variants } = await makeProduct(ctx.db, club, { availableToNonMembers: false, pricePaise: 30000 });
    const res = await placeOrder(buyer, club.club.id, [{ variantId: variants.M.id, quantity: 1 }], 30000);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MEMBERS_ONLY_PRODUCT');
    const member = await makeUser(ctx.db);
    const { term } = await makeActiveMember(ctx.db, club, member);
    // Real PricingPolicy: the member's plan gives 10 % off → 27 000.
    const ok = await placeOrder(await ctx.signIn(member.id), club.club.id, [{ variantId: variants.M.id, quantity: 1 }], 27000);
    expect(ok.status).toBe(201);
    expect(ok.body.data.order.buyerType).toBe('MEMBER');
    expect((await ctx.db('orders').where({ id: ok.body.data.order.id }).first()).membership_term_id).toBe(term.id);
  });

  it('zero total is PRODUCT_NOT_ORDERABLE (ZERO_TOTAL, OQ-19); line prices come from PricingPolicy, not the client', async () => {
    const free = buildTestContext({
      group1Overrides: { pricing: { quoteMerchItem: async () => ({ listPricePaise: 50000, discountPaise: 50000, finalPricePaise: 0, priceRule: 'MEMBER_DISCOUNT' }) } },
    });
    try {
      const { variants } = await makeProduct(free.db, club);
      const res = await placeOrder(await free.signIn(buyerUser.id), club.club.id, [{ variantId: variants.M.id, quantity: 1 }], 0);
      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({ code: 'PRODUCT_NOT_ORDERABLE', details: { reason: 'ZERO_TOTAL' } });
    } finally {
      await free.close();
    }
    const discounted = buildTestContext({
      group1Overrides: { pricing: { quoteMerchItem: async (p) => ({ listPricePaise: p.pricePaise, discountPaise: 5000, finalPricePaise: p.pricePaise - 5000, priceRule: 'MEMBER_DISCOUNT' }) } },
    });
    try {
      const { variants } = await makeProduct(discounted.db, club, { pricePaise: 50000 });
      const res = await placeOrder(await discounted.signIn(buyerUser.id), club.club.id, [{ variantId: variants.M.id, quantity: 2 }], 90000);
      expect(res.body.data.order).toMatchObject({ subtotalPaise: 100000, discountPaise: 10000, totalPaise: 90000 });
      expect(res.body.data.order.items[0]).toMatchObject({ unitListPricePaise: 50000, unitDiscountPaise: 5000, unitFinalPricePaise: 45000, lineTotalPaise: 90000, priceRule: 'MEMBER_DISCOUNT' });
    } finally {
      await discounted.close();
    }
  });

  it('quote endpoint: lines, totals, OUT_OF_STOCK pre-check, malformed items', async () => {
    const { variants } = await makeProduct(ctx.db, club, { pricePaise: 25000, variants: [{ size: 'M', stock: 3 }] });
    const q = await buyer.get(`/api/v1/clubs/${club.club.id}/orders/quote?items=${variants.M.id}:2`);
    expect(q.status).toBe(200);
    expect(q.body.data).toMatchObject({ subtotalPaise: 50000, discountPaise: 0, totalPaise: 50000, lines: [{ sizeLabel: 'M', quantity: 2 }] });
    expect((await buyer.get(`/api/v1/clubs/${club.club.id}/orders/quote?items=${variants.M.id}:4`)).body.error.code).toBe('OUT_OF_STOCK');
    expect((await buyer.get(`/api/v1/clubs/${club.club.id}/orders/quote?items=nope`)).status).toBe(400);
    expect((await request(ctx.app).get(`/api/v1/clubs/${club.club.id}/orders/quote?items=${variants.M.id}:1`)).status).toBe(401);
  });

  it('cancel (owner, PENDING_PAYMENT) releases stock; others 404; confirmed orders CONFLICT_STATE', async () => {
    const { variants } = await makeProduct(ctx.db, club, { pricePaise: 1000, variants: [{ size: 'M', stock: 5 }] });
    const a = (await placeOrder(buyer, club.club.id, [{ variantId: variants.M.id, quantity: 2 }], 2000)).body.data;
    const stranger = await ctx.signIn((await makeUser(ctx.db)).id);
    expect((await stranger.post(`/api/v1/orders/${a.order.id}/cancel`).set(H)).status).toBe(404);
    const cancelled = await buyer.post(`/api/v1/orders/${a.order.id}/cancel`).set(H);
    expect(cancelled.body.data).toMatchObject({ status: 'CANCELLED', cancelReason: 'USER_CANCELLED', payment: { status: 'FAILED' } });
    expect((await variantRow(ctx.db, variants.M.id)).stock_reserved).toBe(0);
    expect((await buyer.post(`/api/v1/orders/${a.order.id}/cancel`).set(H)).body.error.code).toBe('CONFLICT_STATE');
    const b = (await placeOrder(buyer, club.club.id, [{ variantId: variants.M.id, quantity: 1 }], 1000)).body.data;
    await pay(buyer, b.payment.id);
    expect((await buyer.post(`/api/v1/orders/${b.order.id}/cancel`).set(H)).body.error).toMatchObject({ code: 'CONFLICT_STATE', details: { currentStatus: 'CONFIRMED' } });
  });

  it('Idempotency-Key replay of an order returns the stored response and reserves once', async () => {
    const { variants } = await makeProduct(ctx.db, club, { pricePaise: 1000, variants: [{ size: 'M', stock: 5 }] });
    const key = idemKey();
    const a = await placeOrder(buyer, club.club.id, [{ variantId: variants.M.id, quantity: 2 }], 2000, key);
    const b = await placeOrder(buyer, club.club.id, [{ variantId: variants.M.id, quantity: 2 }], 2000, key);
    expect(b.status).toBe(201);
    expect(b.body).toEqual(a.body);
    expect(await ctx.db('orders')).toHaveLength(1);
    expect((await variantRow(ctx.db, variants.M.id)).stock_reserved).toBe(2);
  });

  it('/me/orders lists own orders with pickup codes; club list (CH, TR) shows buyers but not pickup codes', async () => {
    const { variants } = await makeProduct(ctx.db, club, { pricePaise: 1000 });
    const placed = (await placeOrder(buyer, club.club.id, [{ variantId: variants.M.id, quantity: 1 }], 1000)).body.data;
    await pay(buyer, placed.payment.id);
    const mine = await buyer.get('/api/v1/me/orders');
    expect(mine.body.total).toBe(1);
    expect(mine.body.data[0].pickupCode).toMatch(/^[0-9A-Z]{8}$/);
    const list = await (await ctx.signIn(club.treasurer.id)).get(`/api/v1/clubs/${club.club.id}/orders?status=CONFIRMED`);
    expect(list.body.total).toBe(1);
    expect(list.body.data[0]).toMatchObject({ buyer: { id: buyerUser.id, fullName: 'Buyer' }, status: 'CONFIRMED' });
    expect(list.body.data[0].pickupCode).toBeUndefined();
  });
});

describe('pickup (T-63) — TC-MER-06', () => {
  let ctx;
  let club;
  let other;
  beforeAll(() => {
    ctx = buildTestContext();
  });
  afterAll(() => ctx.close());
  beforeEach(async () => {
    await truncateAll(ctx.db);
    club = await makeClub(ctx.db);
    other = await makeClub(ctx.db);
  });

  async function confirmedOrder() {
    const { variants } = await makeProduct(ctx.db, club, { pricePaise: 1000 });
    const buyer = await ctx.signIn((await makeUser(ctx.db)).id);
    const placed = (await placeOrder(buyer, club.club.id, [{ variantId: variants.M.id, quantity: 1 }], 1000)).body.data;
    const paid = await pay(buyer, placed.payment.id);
    return { orderId: placed.order.id, code: paid.body.data.result.pickupCode };
  }
  const pickup = (agent, clubId, pickupCode, key = idemKey()) => agent.post(`/api/v1/clubs/${clubId}/pickups`).set(H).set('Idempotency-Key', key).send({ pickupCode });

  it('club head verifies the code: PICKED_UP once; reuse → ALREADY_PICKED_UP; audited', async () => {
    const { orderId, code } = await confirmedOrder();
    const head = await ctx.signIn(club.head.id);
    const first = await pickup(head, club.club.id, code.toLowerCase());
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ id: orderId, status: 'PICKED_UP', pickedUpAt: ctx.clock.now().toISOString() });
    const again = await pickup(head, club.club.id, code);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_PICKED_UP');
    expect(await ctx.db('audit_logs').where({ action: 'ORDER_PICKED_UP', entity_id: orderId })).toHaveLength(1);
  });

  it('unknown code, or a code of another club → PICKUP_CODE_NOT_FOUND; treasurer/volunteer cannot verify', async () => {
    const { code } = await confirmedOrder();
    expect((await pickup(await ctx.signIn(club.head.id), club.club.id, 'ZZZZZZZZ')).body.error.code).toBe('PICKUP_CODE_NOT_FOUND');
    expect((await pickup(await ctx.signIn(other.head.id), other.club.id, code)).body.error.code).toBe('PICKUP_CODE_NOT_FOUND');
    expect((await pickup(await ctx.signIn(club.treasurer.id), club.club.id, code)).status).toBe(403);
    expect((await pickup(await ctx.signIn(other.head.id), club.club.id, code)).status).toBe(404);
  });

  it('10 parallel pickups of one code → exactly one success', async () => {
    const { code } = await confirmedOrder();
    const agents = await Promise.all(Array.from({ length: 10 }, () => ctx.signIn(club.head.id)));
    const res = await Promise.all(agents.map((a) => pickup(a, club.club.id, code)));
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409 && r.body.error.code === 'ALREADY_PICKED_UP')).toHaveLength(9);
  });
});
