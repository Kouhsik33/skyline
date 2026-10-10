import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestContext } from '../helpers/testApp.js';
import { truncateAll } from '../helpers/testDb.js';
import { pay, placeOrder, variantRow } from '../helpers/merch.js';
import { makeActiveMember, makeClub, makeUser } from '../fixtures/factories.js';

// C9 — the merchandise order flow end to end on the real merged app and REAL pricing
// (pricing.quoteMerchItem, LLD §2.6): quote → order → Group 1's POST /payments/:id/simulate →
// MERCH_ORDER handler (shared registry) → CONFIRMED, stock sold, ledger MERCH_SALE, pickup.

const H = { 'X-Requested-With': 'soms' };

describe('order flow end to end on real pricing (C9, TC-MER-05 in context)', () => {
  let ctx;
  let club;
  beforeAll(() => {
    ctx = buildTestContext(); // clock 2026-11-01 10:00 IST
  });
  afterAll(() => ctx.close());
  beforeEach(async () => {
    await truncateAll(ctx.db);
    club = await makeClub(ctx.db);
  });

  async function catalogue({ offer } = {}) {
    const head = await ctx.signIn(club.head.id);
    const cat = (await head.post(`/api/v1/clubs/${club.club.id}/product-categories`).set(H).send({ name: 'Apparel' })).body.data;
    const created = await head
      .post(`/api/v1/clubs/${club.club.id}/products`)
      .set(H)
      .send({
        categoryId: cat.id,
        name: 'Club Tee',
        pricePaise: 50000,
        memberDiscountEligible: true,
        availableToNonMembers: true,
        ...(offer ? { offerPricePaise: offer, offerStartsAt: '2026-10-25T00:00:00Z', offerEndsAt: '2026-11-10T00:00:00Z' } : {}),
        variants: [{ sizeLabel: 'M', initialStock: 10 }],
      });
    expect(created.status).toBe(201);
    await head.post(`/api/v1/products/${created.body.data.id}/status`).set(H).send({ status: 'ACTIVE' }).expect(200);
    return created.body.data.variants[0].id;
  }

  it('member: quote 45 000 (10 % off) → order → pay → CONFIRMED, stock sold, ledger = charged total', async () => {
    const variantId = await catalogue();
    const memberUser = await makeUser(ctx.db);
    await makeActiveMember(ctx.db, club, memberUser);
    const member = await ctx.signIn(memberUser.id);

    const quote = await member.get(`/api/v1/clubs/${club.club.id}/orders/quote?items=${variantId}:2`);
    expect(quote.body.data).toMatchObject({ subtotalPaise: 100000, discountPaise: 10000, totalPaise: 90000, lines: [{ priceRule: 'MEMBER_DISCOUNT', unitFinalPricePaise: 45000 }] });

    // the client's expected total is compared, never charged
    expect((await placeOrder(member, club.club.id, [{ variantId, quantity: 2 }], 100000)).body.error.code).toBe('PRICE_CHANGED');
    const placed = await placeOrder(member, club.club.id, [{ variantId, quantity: 2 }], 90000);
    expect(placed.status).toBe(201);
    expect(placed.body.data.payment).toMatchObject({ amountPaise: 90000, status: 'INITIATED', isSimulated: true });

    const paid = await pay(member, placed.body.data.payment.id); // Group 1's simulate route
    expect(paid.status).toBe(200);
    expect(paid.body.data).toMatchObject({ status: 'SUCCEEDED', result: { orderStatus: 'CONFIRMED', pickupCode: expect.stringMatching(/^[0-9A-Z]{8}$/) } });
    expect(await variantRow(ctx.db, variantId)).toMatchObject({ stock_on_hand: 8, stock_reserved: 0 });
    const ledger = await ctx.db('financial_transactions').where({ order_id: placed.body.data.order.id });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ category: 'MERCH_SALE', amount_paise: 90000, direction: 'IN' });

    const head = await ctx.signIn(club.head.id);
    const pickup = await head.post(`/api/v1/clubs/${club.club.id}/pickups`).set(H).set('Idempotency-Key', crypto.randomUUID()).send({ pickupCode: paid.body.data.result.pickupCode });
    expect(pickup.body.data.status).toBe('PICKED_UP');
  });

  it('BEST_OF with an active offer: member pays the cheaper offer (42 000), not offer − 10 %', async () => {
    const variantId = await catalogue({ offer: 42000 });
    const memberUser = await makeUser(ctx.db);
    await makeActiveMember(ctx.db, club, memberUser);
    const member = await ctx.signIn(memberUser.id);
    const placed = await placeOrder(member, club.club.id, [{ variantId, quantity: 1 }], 42000);
    expect(placed.status).toBe(201);
    expect(placed.body.data.order.items[0]).toMatchObject({ priceRule: 'OFFER', unitFinalPricePaise: 42000 });
    await pay(member, placed.body.data.payment.id).expect(200);
    expect((await ctx.db('financial_transactions').where({ order_id: placed.body.data.order.id }).first()).amount_paise).toBe(42000);
  });

  it('non-member: list price; a FAILED payment releases the stock through the same handler', async () => {
    const variantId = await catalogue();
    const buyer = await ctx.signIn((await makeUser(ctx.db)).id);
    const placed = await placeOrder(buyer, club.club.id, [{ variantId, quantity: 3 }], 150000);
    expect(placed.status).toBe(201);
    await pay(buyer, placed.body.data.payment.id, 'FAILED').expect(200);
    expect(await variantRow(ctx.db, variantId)).toMatchObject({ stock_on_hand: 10, stock_reserved: 0 });
    expect((await ctx.db('orders').where({ id: placed.body.data.order.id }).first()).status).toBe('CANCELLED');
  });
});
