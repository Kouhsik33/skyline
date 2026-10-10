import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestContext, idemKey } from '../helpers/testApp.js';
import { truncateAll } from '../helpers/testDb.js';
import { adjust, buy, placeOrder, variantRow } from '../helpers/merch.js';
import { assignRole, makeActiveMember, makeClub, makeProduct, makeUser } from '../fixtures/factories.js';

// T-60 catalogue and T-61 stock/low-stock (LLD §2.8, §4.7, §5.10). TC-MER-04.

const H = { 'X-Requested-With': 'soms' };

describe('catalogue (T-60)', () => {
  let ctx;
  let club;
  let other;
  let head;
  beforeAll(() => {
    ctx = buildTestContext();
  });
  afterAll(() => ctx.close());
  beforeEach(async () => {
    await truncateAll(ctx.db);
    club = await makeClub(ctx.db);
    other = await makeClub(ctx.db);
    head = await ctx.signIn(club.head.id);
  });

  async function category(name = 'Apparel') {
    return (await head.post(`/api/v1/clubs/${club.club.id}/product-categories`).set(H).send({ name })).body.data;
  }
  const productBody = (categoryId, extra = {}) => ({
    categoryId,
    name: 'Club Tee',
    description: 'Cotton',
    pricePaise: 50000,
    memberDiscountEligible: true,
    availableToNonMembers: true,
    variants: [{ sizeLabel: 's', initialStock: 5 }, { sizeLabel: 'M', initialStock: 0, lowStockThreshold: 2 }],
    ...extra,
  });

  it('categories: CH creates; names unique per club ignoring case (CATEGORY_NAME_TAKEN); public list', async () => {
    const c = await category('Apparel');
    expect(c).toMatchObject({ name: 'Apparel', clubId: club.club.id });
    const dup = await head.post(`/api/v1/clubs/${club.club.id}/product-categories`).set(H).send({ name: 'APPAREL' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CATEGORY_NAME_TAKEN');
    expect((await (await ctx.signIn(other.head.id)).post(`/api/v1/clubs/${other.club.id}/product-categories`).set(H).send({ name: 'Apparel' })).status).toBe(201);
    const list = await request(ctx.app).get(`/api/v1/clubs/${club.club.id}/product-categories`);
    expect(list.body.data.map((x) => x.name)).toEqual(['Apparel']);
  });

  it('create product: DRAFT, variants with sizes upper-cased, RESTOCK movements for initial stock, audited', async () => {
    const c = await category();
    const res = await head.post(`/api/v1/clubs/${club.club.id}/products`).set(H).send(productBody(c.id));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'DRAFT', pricePaise: 50000, membersOnly: false });
    expect(res.body.data.variants.map((v) => [v.sizeLabel, v.stockOnHand, v.lowStockThreshold])).toEqual([['M', 0, 2], ['S', 5, 5]]);
    const moves = await ctx.db('stock_movements');
    expect(moves.map((m) => [m.type, m.quantity])).toEqual([['RESTOCK', 5]]);
    expect(await ctx.db('audit_logs').where({ action: 'PRODUCT_CREATED' })).toHaveLength(1);
    expect(await ctx.db('low_stock_alerts')).toHaveLength(0); // creation is not an evaluation point (LLD §5.10)
  });

  it('create product validation: offer rules, duplicate sizes, unknown/other-club category, no variants', async () => {
    const c = await category();
    const otherCat = (await (await ctx.signIn(other.head.id)).post(`/api/v1/clubs/${other.club.id}/product-categories`).set(H).send({ name: 'X' })).body.data;
    const win = { offerStartsAt: '2026-11-01T00:00:00Z', offerEndsAt: '2026-11-30T00:00:00Z' };
    for (const extra of [
      { offerPricePaise: 40000 },
      { offerPricePaise: 60000, ...win },
      { variants: [{ sizeLabel: 'M', initialStock: 1 }, { sizeLabel: 'm', initialStock: 1 }] },
      { variants: [] },
      { pricePaise: 0 },
      { pricePaise: 100.5 },
      { categoryId: otherCat.id },
    ]) {
      const res = await head.post(`/api/v1/clubs/${club.club.id}/products`).set(H).send(productBody(c.id, extra));
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
    expect((await head.post(`/api/v1/clubs/${club.club.id}/products`).set(H).send(productBody(c.id, { offerPricePaise: 40000, ...win }))).status).toBe(201);
  });

  it('status transitions (OQ-20) and visibility: public sees ACTIVE only; CH sees all with ?all=true', async () => {
    const c = await category();
    const id = (await head.post(`/api/v1/clubs/${club.club.id}/products`).set(H).send(productBody(c.id))).body.data.id;
    const anon = request(ctx.app);
    expect((await anon.get(`/api/v1/clubs/${club.club.id}/products`)).body.data).toEqual([]);
    expect((await anon.get(`/api/v1/products/${id}`)).status).toBe(404);
    expect((await head.get(`/api/v1/products/${id}`)).status).toBe(200);
    expect((await head.get(`/api/v1/clubs/${club.club.id}/products?all=true`)).body.data).toHaveLength(1);
    expect((await (await ctx.signIn((await makeUser(ctx.db)).id)).get(`/api/v1/clubs/${club.club.id}/products?all=true`)).status).toBe(404);

    const status = (s) => head.post(`/api/v1/products/${id}/status`).set(H).send({ status: s });
    expect((await status('INACTIVE')).body.error).toMatchObject({ code: 'CONFLICT_STATE', details: { currentStatus: 'DRAFT' } });
    expect((await status('ACTIVE')).body.data.status).toBe('ACTIVE');
    const pub = await anon.get(`/api/v1/clubs/${club.club.id}/products`);
    expect(pub.body.data).toHaveLength(1);
    expect(pub.body.data[0].variants.map((v) => [v.sizeLabel, v.available, v.orderable])).toEqual([['M', 0, false], ['S', 5, true]]);
    expect(pub.body.data[0].variants[0].stockOnHand).toBeUndefined();
    expect(pub.body.data[0].displayPrice).toBeUndefined();
    expect((await status('INACTIVE')).body.data.status).toBe('INACTIVE');
    expect((await status('ARCHIVED')).body.data.status).toBe('ARCHIVED');
    expect((await status('ACTIVE')).body.error.code).toBe('CONFLICT_STATE');
    expect((await head.patch(`/api/v1/products/${id}`).set(H).send({ name: 'x' })).body.error.code).toBe('CONFLICT_STATE');
    expect(await ctx.db('audit_logs').where({ action: 'PRODUCT_STATUS_CHANGED' })).toHaveLength(3);
  });

  it('signed-in callers get a display price from PricingPolicy; members-only product shows null to non-members', async () => {
    const { product } = await makeProduct(ctx.db, club, { availableToNonMembers: false, pricePaise: 70000 });
    const nonMember = await ctx.signIn((await makeUser(ctx.db)).id);
    const member = await makeUser(ctx.db);
    await makeActiveMember(ctx.db, club, member);
    expect((await nonMember.get(`/api/v1/products/${product.id}`)).body.data).toMatchObject({ membersOnly: true, displayPrice: null });
    expect((await (await ctx.signIn(member.id)).get(`/api/v1/products/${product.id}`)).body.data.displayPrice).toEqual({
      listPricePaise: 70000, discountPaise: 7000, finalPricePaise: 63000, priceRule: 'MEMBER_DISCOUNT', // real pricing, plan 10 %
    });
  });

  it('PATCH product (CH): fields and offer re-validated against current values; price change audited with before/after', async () => {
    const { product } = await makeProduct(ctx.db, club, { pricePaise: 50000 });
    const res = await head.patch(`/api/v1/products/${product.id}`).set(H).send({ pricePaise: 55000, description: 'New' });
    expect(res.body.data).toMatchObject({ pricePaise: 55000, description: 'New' });
    const audit = await ctx.db('audit_logs').where({ action: 'PRODUCT_UPDATED' }).first();
    expect(audit.metadata).toMatchObject({ before: { pricePaise: 50000 }, after: { pricePaise: 55000 } });
    const bad = await head.patch(`/api/v1/products/${product.id}`).set(H).send({ offerPricePaise: 60000, offerStartsAt: '2026-11-01T00:00:00Z', offerEndsAt: '2026-11-02T00:00:00Z' });
    expect(bad.status).toBe(400);
    expect((await head.patch(`/api/v1/products/${product.id}`).set(H).send({ stockOnHand: 99 })).status).toBe(400);
  });

  it('variants: add (SIZE_EXISTS), patch threshold re-evaluates low stock', async () => {
    const { product, variants } = await makeProduct(ctx.db, club, { variants: [{ size: 'M', stock: 4, threshold: 1 }] });
    const added = await head.post(`/api/v1/products/${product.id}/variants`).set(H).send({ sizeLabel: 'l', initialStock: 3 });
    expect(added.status).toBe(201);
    expect(added.body.data).toMatchObject({ sizeLabel: 'L', stockOnHand: 3 });
    const dup = await head.post(`/api/v1/products/${product.id}/variants`).set(H).send({ sizeLabel: 'M', initialStock: 1 });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('SIZE_EXISTS');
    const patched = await head.patch(`/api/v1/variants/${variants.M.id}`).set(H).send({ lowStockThreshold: 4 });
    expect(patched.body.data.lowStockThreshold).toBe(4);
    expect(await ctx.db('low_stock_alerts').where({ variant_id: variants.M.id, status: 'OPEN' })).toHaveLength(1);
    await head.patch(`/api/v1/variants/${variants.M.id}`).set(H).send({ lowStockThreshold: 1 });
    expect(await ctx.db('low_stock_alerts').where({ variant_id: variants.M.id, status: 'OPEN' })).toHaveLength(0);
  });
});

describe('stock and low-stock alerts (T-61)', () => {
  let ctx;
  let club;
  let head;
  let head2;
  beforeAll(() => {
    ctx = buildTestContext();
  });
  afterAll(() => ctx.close());
  beforeEach(async () => {
    await truncateAll(ctx.db);
    club = await makeClub(ctx.db);
    head2 = await makeUser(ctx.db, { fullName: 'Second Head' });
    await assignRole(ctx.db, club.club.id, head2.id, 'CLUB_HEAD');
    head = await ctx.signIn(club.head.id);
  });

  it('RESTOCK and ADJUSTMENT write movements and audit; STOCK_BELOW_RESERVED protects reservations', async () => {
    const { variants } = await makeProduct(ctx.db, club, { variants: [{ size: 'M', stock: 5 }] });
    const id = variants.M.id;
    expect((await adjust(head, id, { type: 'RESTOCK', quantity: 10, reason: 'Delivery' })).body.data).toMatchObject({ stockOnHand: 15, available: 15 });
    expect((await adjust(head, id, { type: 'ADJUSTMENT', quantity: -3, reason: 'Damaged' })).body.data.stockOnHand).toBe(12);
    const buyer = await ctx.signIn((await makeUser(ctx.db)).id);
    expect((await placeOrder(buyer, club.club.id, [{ variantId: id, quantity: 10 }], 500000)).status).toBe(201);
    const below = await adjust(head, id, { type: 'ADJUSTMENT', quantity: -3, reason: 'Count' });
    expect(below.status).toBe(422);
    expect(below.body.error).toMatchObject({ code: 'STOCK_BELOW_RESERVED', details: { stockOnHand: 12, stockReserved: 10 } });
    expect((await adjust(head, id, { type: 'ADJUSTMENT', quantity: -2, reason: 'Count' })).status).toBe(200);
    const moves = await ctx.db('stock_movements').where({ variant_id: id }).orderBy('created_at');
    expect(moves.map((m) => [m.type, m.quantity])).toEqual([['RESTOCK', 10], ['ADJUSTMENT', -3], ['RESERVE', 10], ['ADJUSTMENT', -2]]);
    expect(await ctx.db('audit_logs').where({ action: 'STOCK_ADJUSTED' })).toHaveLength(3);
  });

  it('validation: RESTOCK must be positive, quantity non-zero, reason required; idempotent replay', async () => {
    const { variants } = await makeProduct(ctx.db, club);
    const id = variants.M.id;
    for (const body of [{ type: 'RESTOCK', quantity: -1, reason: 'x' }, { type: 'ADJUSTMENT', quantity: 0, reason: 'x' }, { type: 'RESTOCK', quantity: 1 }, { type: 'SALE', quantity: 1, reason: 'x' }]) {
      expect((await adjust(head, id, body)).status, JSON.stringify(body)).toBe(400);
    }
    const key = idemKey();
    const a = await adjust(head, id, { type: 'RESTOCK', quantity: 2, reason: 'x' }, key);
    const b = await adjust(head, id, { type: 'RESTOCK', quantity: 2, reason: 'x' }, key);
    expect(b.body).toEqual(a.body);
    expect((await variantRow(ctx.db, id)).stock_on_hand).toBe(12);
  });

  it('TC-MER-04: low-stock alert once per crossing; one email per club head per alert', async () => {
    // threshold 3; start 5. sell 3 → available 2 (alert 1); sell 1 → 1 (no new alert);
    // restock 10 → 11 (resolved); sell 8 → 3 (alert 2). 2 alerts; 2 heads × 2 alerts = 4 emails.
    const { variants } = await makeProduct(ctx.db, club, { pricePaise: 1000, variants: [{ size: 'M', stock: 5, threshold: 3 }] });
    const id = variants.M.id;
    const buyer = await ctx.signIn((await makeUser(ctx.db)).id);
    await buy(buyer, club.club.id, id, 3, 1000);
    expect(await ctx.db('low_stock_alerts')).toHaveLength(1);
    await buy(buyer, club.club.id, id, 1, 1000);
    expect(await ctx.db('low_stock_alerts')).toHaveLength(1);
    await adjust(head, id, { type: 'RESTOCK', quantity: 10, reason: 'Delivery' });
    expect((await ctx.db('low_stock_alerts').first()).status).toBe('RESOLVED');
    await buy(buyer, club.club.id, id, 8, 1000);
    const alerts = await ctx.db('low_stock_alerts').orderBy('triggered_at');
    expect(alerts.map((a) => [a.status, a.available_at_trigger, a.threshold_at_trigger])).toEqual([['RESOLVED', 2, 3], ['OPEN', 3, 3]]);
    const emails = await ctx.db('notification_deliveries').where({ template: 'LOW_STOCK_ALERT' });
    expect(emails).toHaveLength(4);
    for (const h of [club.head.id, head2.id]) expect(emails.filter((e) => e.recipient_user_id === h)).toHaveLength(2);
    expect(emails.every((e) => e.channel === 'EMAIL' && e.status === 'PENDING')).toBe(true);
  });

  it('inventory (CH, TR) and alerts list (CH)', async () => {
    const { variants } = await makeProduct(ctx.db, club, { name: 'Hoodie', variants: [{ size: 'M', stock: 2, threshold: 3 }, { size: 'L', stock: 9, threshold: 3 }] });
    await adjust(head, variants.M.id, { type: 'ADJUSTMENT', quantity: -1, reason: 'lost' });
    const inv = await (await ctx.signIn(club.treasurer.id)).get(`/api/v1/clubs/${club.club.id}/inventory`);
    expect(inv.body.data.map((r) => [r.sizeLabel, r.onHand, r.reserved, r.available, r.threshold, Boolean(r.alert)])).toEqual([
      ['L', 9, 0, 9, 3, false],
      ['M', 1, 0, 1, 3, true],
    ]);
    const alerts = await head.get(`/api/v1/clubs/${club.club.id}/low-stock-alerts?status=OPEN`);
    expect(alerts.body.data).toHaveLength(1);
    expect(alerts.body.data[0]).toMatchObject({ productName: 'Hoodie', sizeLabel: 'M', availableAtTrigger: 1 });
  });
});
