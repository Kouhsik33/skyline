import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestContext, idemKey } from '../helpers/testApp.js';
import { truncateAll } from '../helpers/testDb.js';
import { verifyStudent } from '../helpers/factories.js';
import { pay, placeOrder } from '../helpers/merch.js';
import { expectStatus, makeCast, matrixRows } from '../helpers/authzMatrix.js';
import { makeProduct, makeUser } from '../fixtures/factories.js';

// TC-RPT-02 (T-85) — membership and merchandise reports on REAL data: members join through Group 1's
// POST /clubs/:clubId/memberships and pay through POST /payments/:id/simulate; orders go through the
// real merchandise flow. Clock 2026-11-01 10:00 IST. Expected values, by hand:
//   Annual (₹500, 12 m, 10 % merch): m1 joins + pays → ACTIVE until 2027-10-31
//   Semester (₹200, 6 m):            m2 joins + pays → ACTIVE until 2027-04-30
//   Annual:                          m3 joins, payment FAILED → CANCELLED (not active)
//   Annual (seeded row, paid 2026-07-01, expires 2026-11-05, AutoPay on, one SKIPPED attempt): m4
//   → activeMembers 3 (Annual 2, Semester 1); joins 2026-07: 1, 2026-11: 2; dues 50 000 + 20 000 = 70 000
//   → expiringIn7Days 1 (m4); autopayEnabled 1; renewal attempts SKIPPED 1
//   Merch (Tee ₹500): m1 buys 2×M at 10 % off = 90 000 (paid); buyer 1×L 50 000 (paid);
//   buyer 1×M pending; buyer 1×L then FAILED (cancelled)
//   → units M 2, L 1 (total 3); revenue 140 000; CONFIRMED 2, PENDING_PAYMENT 1, CANCELLED 1
//   → inventory M on hand 8, reserved 1, available 7; L on hand 1, available 1, low (threshold 3); open alerts 1

const H = { 'X-Requested-With': 'soms' };

describe('TC-RPT-02 membership & merchandise reports (T-85)', () => {
  let ctx;
  let cast;
  let club;
  beforeAll(async () => {
    ctx = buildTestContext();
    await truncateAll(ctx.db);
    cast = await makeCast(ctx);
    club = cast.a;
    const db = ctx.db;
    const [annual] = await db('membership_plans').insert({ club_id: club.club.id, name: 'Annual', fee_paise: 50000, duration_months: 12, merch_discount_bps: 1000, created_by: club.head.id }).returning('*');
    const [semester] = await db('membership_plans').insert({ club_id: club.club.id, name: 'Semester', fee_paise: 20000, duration_months: 6, created_by: club.head.id }).returning('*');

    async function join(plan, outcome) {
      const u = await makeUser(db);
      await verifyStudent(db, u.id);
      const agent = await ctx.signIn(u.id);
      const res = await agent.post(`/api/v1/clubs/${club.club.id}/memberships`).set(H).set('Idempotency-Key', idemKey()).send({ planId: plan.id, expectedFeePaise: plan.fee_paise });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      await pay(agent, res.body.data.payment.id, outcome).expect(200);
      return { user: u, agent };
    }
    const m1 = await join(annual, 'SUCCEEDED');
    await join(semester, 'SUCCEEDED');
    await join(annual, 'FAILED');

    const m4 = await makeUser(db);
    const [mem] = await db('memberships')
      .insert({ user_id: m4.id, club_id: club.club.id, status: 'ACTIVE', member_number: 'C-999', current_plan_id: annual.id, started_on: '2025-11-06', expires_on: '2026-11-05', qr_token: `rpt-${crypto.randomUUID()}`, autopay_enabled: true, autopay_plan_id: annual.id, autopay_amount_paise: 50000 })
      .returning('*');
    await db('membership_terms').insert({ membership_id: mem.id, club_id: club.club.id, user_id: m4.id, kind: 'JOIN', source: 'MANUAL', plan_id: annual.id, plan_name: 'Annual', fee_paise: 50000, duration_months: 12, event_discount_bps: 0, merch_discount_bps: 1000, early_bird_access: false, status: 'PAID', starts_on: '2025-11-06', ends_on: '2026-11-05', paid_at: '2026-07-01T04:30:00Z' });
    await db('renewal_attempts').insert({ membership_id: mem.id, for_expires_on: '2026-11-05', status: 'SKIPPED', skip_reason: 'PLAN_ARCHIVED' });

    const { variants } = await makeProduct(db, club, { name: 'Tee', pricePaise: 50000, variants: [{ size: 'M', stock: 10, threshold: 0 }, { size: 'L', stock: 3, threshold: 3 }] });
    const o1 = await placeOrder(m1.agent, club.club.id, [{ variantId: variants.M.id, quantity: 2 }], 90000);
    await pay(m1.agent, o1.body.data.payment.id).expect(200);
    const buyer = await ctx.signIn((await makeUser(db)).id);
    const o2 = await placeOrder(buyer, club.club.id, [{ variantId: variants.L.id, quantity: 1 }], 50000);
    await pay(buyer, o2.body.data.payment.id).expect(200);
    expect((await placeOrder(buyer, club.club.id, [{ variantId: variants.M.id, quantity: 1 }], 50000)).status).toBe(201);
    const o4 = await placeOrder(await ctx.signIn((await makeUser(db)).id), club.club.id, [{ variantId: variants.L.id, quantity: 1 }], 50000);
    expect(o4.status).toBe(201);
    const o4owner = await ctx.db('orders').where({ id: o4.body.data.order.id }).first();
    await pay(await ctx.signIn(o4owner.user_id), o4.body.data.payment.id, 'FAILED').expect(200);
  }, 120000);
  afterAll(() => ctx.close());

  it('membership report matches the hand-computed figures', async () => {
    const res = await cast.agents.TR_A.get(`/api/v1/clubs/${club.club.id}/reports/memberships`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      asOf: '2026-11-01',
      activeMembers: 3,
      activeMembersByPlan: [
        { planId: expect.any(String), planName: 'Annual', members: 2 },
        { planId: expect.any(String), planName: 'Semester', members: 1 },
      ],
      joinsAndRenewalsByMonth: [
        { month: '2026-07', joins: 1, renewals: 0 },
        { month: '2026-11', joins: 2, renewals: 0 },
      ],
      duesCollectedPaise: 70000,
      expiringIn7Days: 1,
      autopayEnabled: 1,
      renewalAttempts: [{ status: 'SKIPPED', attempts: 1 }],
    });
  });

  it('merchandise report matches the hand-computed figures', async () => {
    const res = await cast.agents.CH_A.get(`/api/v1/clubs/${club.club.id}/reports/merchandise`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      unitsSold: [
        { productId: expect.any(String), productName: 'Tee', sizeLabel: 'L', units: 1 },
        { productId: expect.any(String), productName: 'Tee', sizeLabel: 'M', units: 2 },
      ],
      totalUnitsSold: 3,
      revenuePaise: 140000,
      ordersByStatus: [
        { status: 'CANCELLED', orders: 1 },
        { status: 'CONFIRMED', orders: 2 },
        { status: 'PENDING_PAYMENT', orders: 1 },
      ],
      inventory: [
        { productName: 'Tee', sizeLabel: 'L', onHand: 2, reserved: 0, available: 2, threshold: 3, lowStock: true },
        { productName: 'Tee', sizeLabel: 'M', onHand: 8, reserved: 1, available: 7, threshold: 0, lowStock: false },
      ],
      openAlerts: 1,
    });
  });

  const both = { ANON: 401, AUTH_OTHER: 404, VOL_A: 403, TR_A: 200, CH_A: 200, ORG_A: 403, TR_B: 404, CH_B: 404 };
  it.each(matrixRows({ memberships: both, merchandise: both }))('TC-AZ-01 GET /reports/%s as %s → %i', async (report, actor, status) => {
    await expectStatus(await cast.agents[actor].get(`/api/v1/clubs/${club.club.id}/reports/${report}`), status);
  });
});
