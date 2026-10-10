import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestContext, idemKey } from '../helpers/testApp.js';
import { truncateAll } from '../helpers/testDb.js';
import { approve, markPaid, reject, submitExpense } from '../helpers/finance.js';
import { makeClub, makeEventWithOrganizer, makeFundraiser, makeMembershipPayment, makeUser } from '../fixtures/factories.js';

// T-83 — TC-FIN-03 (finance formulas), transactions, TC-FIN-05 (reconciliation).
//
// Fixture for club A (clock: 2026-11-01 10:00 IST). Expected values are written out by hand.
//   Payments   MEMBERSHIP_JOIN 50000 SUCCEEDED (settled 2026-11-01)  → ledger IN MEMBERSHIP_DUES 50000
//              MEMBERSHIP_JOIN 30000 FAILED                          → no ledger
//              MEMBERSHIP_JOIN 20000 INITIATED (pending)             → no ledger
//   Income     FUNDRAISER_INCOME 15000 received 2026-10-31; 5000 received 2026-09-15
//   Expenses   DIRECT 12000 incurred 2026-10-29                      → PAID, ledger OUT
//              REIMBURSEMENT 25000 paid 2026-10-30                   → PAID, ledger OUT
//              REIMBURSEMENT  8000 APPROVED (incurred 2026-10-20)    → committed, not in ledger
//              REIMBURSEMENT  5000 SUBMITTED                         → pending review only
//              REIMBURSEMENT  3000 REJECTED                          → nothing
//   Budget     2026-07-01 … 2026-12-31, 400000
//   Club B     DIRECT 99999 — must never appear in club A figures
//
//   all-time IN  = 50000 + 15000 + 5000 = 70000      all-time OUT = 12000 + 25000 = 37000
//   availableBalance = 70000 − 37000 = 33000
//   approvedUnpaid = 8000, pendingReview = 5000 (never subtracted)
//   projectedBalance = 33000 − 8000 = 25000
//   October only: IN 15000, OUT 37000; available stays all-time 33000
//   budget: spent 37000, committed 8000, remaining 363000, after committed 355000

const H = { 'X-Requested-With': 'soms' };

describe('finance summary, transactions, reconciliation (T-83)', () => {
  let ctx;
  let A;
  let B;
  let volunteer;
  let organizer;
  let payoutId;
  let duesPaymentId;

  beforeAll(async () => {
    ctx = buildTestContext();
    await truncateAll(ctx.db);
    volunteer = await makeUser(ctx.db, { fullName: 'Vol A' });
    organizer = await makeUser(ctx.db, { fullName: 'Org A' });
    A = await makeClub(ctx.db, { volunteers: [volunteer] });
    B = await makeClub(ctx.db);
    await makeEventWithOrganizer(ctx.db, { club: A.club, head: A.head, organizer });
    const settle = (id, outcome) => ctx.container.withTransaction((trx) => ctx.container.finance.payments.settle(id, outcome, trx));

    const dues = await makeMembershipPayment(ctx, { club: A, amountPaise: 50000 });
    await settle(dues.payment.id, 'SUCCEEDED');
    duesPaymentId = dues.payment.id;
    const failed = await makeMembershipPayment(ctx, { club: A, amountPaise: 30000 });
    await settle(failed.payment.id, 'FAILED');
    await makeMembershipPayment(ctx, { club: A, amountPaise: 20000 });

    const tr = await ctx.signIn(A.treasurer.id);
    const vol = await ctx.signIn(volunteer.id);
    const fundraiser = await makeFundraiser(ctx.db, A);
    for (const [amountPaise, receivedOn] of [[15000, '2026-10-31'], [5000, '2026-09-15']]) {
      const r = await tr
        .post(`/api/v1/clubs/${A.club.id}/income-entries`)
        .set(H)
        .set('Idempotency-Key', idemKey())
        .send({ fundraiserId: fundraiser.id, amountPaise, receivedOn, description: 'cash' });
      expect(r.status).toBe(201);
    }
    expect((await submitExpense(tr, A.club.id, { kind: 'DIRECT', amountPaise: '12000', incurredOn: '2026-10-29' })).status).toBe(201);
    const payout = (await submitExpense(vol, A.club.id, { amountPaise: '25000', incurredOn: '2026-10-10' })).body.data;
    await approve(tr, payout.id);
    expect((await markPaid(tr, payout.id, { payoutReference: 'UPI-9', paidOn: '2026-10-30' })).status).toBe(200);
    payoutId = payout.id;
    const committed = (await submitExpense(vol, A.club.id, { amountPaise: '8000', incurredOn: '2026-10-20' })).body.data;
    await approve(tr, committed.id);
    await submitExpense(vol, A.club.id, { amountPaise: '5000', incurredOn: '2026-10-21' });
    const rejected = (await submitExpense(vol, A.club.id, { amountPaise: '3000', incurredOn: '2026-10-22' })).body.data;
    await reject(tr, rejected.id);
    expect(
      (await tr.post(`/api/v1/clubs/${A.club.id}/budgets`).set(H).send({ name: 'Odd semester', periodStart: '2026-07-01', periodEnd: '2026-12-31', amountPaise: 400000 })).status,
    ).toBe(201);

    expect((await submitExpense(await ctx.signIn(B.treasurer.id), B.club.id, { kind: 'DIRECT', amountPaise: '99999' })).status).toBe(201);
  });
  afterAll(() => ctx.close());

  it('TC-FIN-03: all-time summary equals the hand-computed figures', async () => {
    const res = await (await ctx.signIn(A.treasurer.id)).get(`/api/v1/clubs/${A.club.id}/finance/summary`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      currency: 'INR',
      period: { from: null, to: null },
      totalIncomePaise: 70000,
      incomeByCategory: { MEMBERSHIP_DUES: 50000, MEMBERSHIP_RENEWAL: 0, TICKET_SALE: 0, MERCH_SALE: 0, FUNDRAISER_INCOME: 20000 },
      totalPaidExpensesPaise: 37000,
      availableBalancePaise: 33000,
      approvedUnpaidTotalPaise: 8000,
      pendingReviewTotalPaise: 5000,
      projectedBalancePaise: 25000,
      activeBudget: {
        id: expect.any(String),
        name: 'Odd semester',
        amountPaise: 400000,
        spentPaise: 37000,
        committedPaise: 8000,
        remainingPaise: 363000,
        remainingAfterCommittedPaise: 355000,
      },
      monthly: [
        { month: '2026-09', inPaise: 5000, outPaise: 0 },
        { month: '2026-10', inPaise: 15000, outPaise: 37000 },
        { month: '2026-11', inPaise: 50000, outPaise: 0 },
      ],
    });
  });

  it('TC-FIN-03: a period filters income/expenses by occurredAt; balances stay all-time', async () => {
    const res = await (await ctx.signIn(A.head.id)).get(`/api/v1/clubs/${A.club.id}/finance/summary?from=2026-10-01&to=2026-10-31`);
    expect(res.body.data).toMatchObject({
      period: { from: '2026-10-01', to: '2026-10-31' },
      totalIncomePaise: 15000,
      incomeByCategory: { MEMBERSHIP_DUES: 0, FUNDRAISER_INCOME: 15000 },
      totalPaidExpensesPaise: 37000,
      availableBalancePaise: 33000,
      projectedBalancePaise: 25000,
      monthly: [{ month: '2026-10', inPaise: 15000, outPaise: 37000 }],
    });
  });

  it('summary is visible to every TEAM role (volunteer, organizer) — aggregates only', async () => {
    for (const user of [volunteer, organizer]) {
      const res = await (await ctx.signIn(user.id)).get(`/api/v1/clubs/${A.club.id}/finance/summary`);
      expect(res.status).toBe(200);
      expect(res.body.data.availableBalancePaise).toBe(33000);
      expect(JSON.stringify(res.body)).not.toMatch(/"transactions"|"description"/);
    }
    expect((await (await ctx.signIn(B.head.id)).get(`/api/v1/clubs/${A.club.id}/finance/summary`)).status).toBe(404);
  });

  it('transactions: club ledger rows with names and source links; filters; TR/CH only', async () => {
    const tr = await ctx.signIn(A.treasurer.id);
    const all = await tr.get(`/api/v1/clubs/${A.club.id}/transactions`);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(5);
    const payout = all.body.data.find((t) => t.expenseId === payoutId);
    expect(payout).toMatchObject({
      direction: 'OUT',
      category: 'REIMBURSEMENT_PAYOUT',
      amountPaise: 25000,
      source: { type: 'EXPENSE', id: payoutId },
      recordedBy: { id: A.treasurer.id, fullName: expect.any(String) },
      approvedBy: { id: A.treasurer.id },
      reference: 'UPI-9',
    });
    const dues = all.body.data.find((t) => t.paymentId === duesPaymentId);
    expect(dues).toMatchObject({ category: 'MEMBERSHIP_DUES', recordedBy: null, payer: { id: expect.any(String) } });
    expect((await tr.get(`/api/v1/clubs/${A.club.id}/transactions?direction=OUT`)).body.total).toBe(2);
    expect((await tr.get(`/api/v1/clubs/${A.club.id}/transactions?category=FUNDRAISER_INCOME&from=2026-10-01`)).body.total).toBe(1);
    expect((await tr.get(`/api/v1/clubs/${A.club.id}/transactions?pageSize=2&page=3`)).body.data).toHaveLength(1);
    expect((await (await ctx.signIn(volunteer.id)).get(`/api/v1/clubs/${A.club.id}/transactions`)).status).toBe(403);
    expect((await (await ctx.signIn(B.treasurer.id)).get(`/api/v1/clubs/${A.club.id}/transactions`)).status).toBe(404);
  });

  it('TC-FIN-05: reconciliation is ok on the consistent fixture', async () => {
    const res = await (await ctx.signIn(A.head.id)).get(`/api/v1/clubs/${A.club.id}/finance/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(true);
    expect(res.body.data.mismatches).toEqual([]);
    expect(res.body.data.checks.map((c) => [c.id, c.ok])).toEqual([['a', true], ['b', true], ['c', true], ['d', true]]);
    expect(res.body.data.checks[0].byPurpose.find((p) => p.purpose === 'MEMBERSHIP_JOIN')).toEqual({ purpose: 'MEMBERSHIP_JOIN', paymentsPaise: 50000, ledgerPaise: 50000 });
  });

  it('TC-FIN-05: removing ledger rows in a test-only transaction is reported, then rolled back', async () => {
    const recon = ctx.container.finance.summary;
    const outcome = await ctx.db
      .transaction(async (trx) => {
        // Test-only: lift the append-only trigger inside this transaction, then roll back.
        await trx.raw('ALTER TABLE financial_transactions DISABLE TRIGGER forbid_update_delete');
        await trx('financial_transactions').where({ source_type: 'EXPENSE', source_id: payoutId }).del();
        await trx('financial_transactions').where({ source_type: 'PAYMENT', source_id: duesPaymentId }).del();
        const r = await recon.reconcile(A.club.id, { conn: trx });
        throw Object.assign(new Error('rollback'), { r });
      })
      .catch((e) => e.r);
    expect(outcome.ok).toBe(false);
    expect(outcome.mismatches).toEqual([
      { check: 'a', purpose: 'MEMBERSHIP_JOIN', paymentsPaise: 50000, ledgerPaise: 0 },
      { check: 'b', paymentId: duesPaymentId },
      { check: 'c', paidExpensesPaise: 37000, ledgerOutPaise: 12000 },
    ]);
    // rolled back: trigger and rows are back
    expect((await recon.reconcile(A.club.id)).ok).toBe(true);
    await expect(ctx.db('financial_transactions').where({ source_id: payoutId }).del()).rejects.toThrow(/forbidden on financial_transactions/);
  });

  it('TC-FIN-05: a ledger row whose source is no longer SUCCEEDED is check (d)', async () => {
    const outcome = await ctx.db
      .transaction(async (trx) => {
        await trx('payments').where({ id: duesPaymentId }).update({ status: 'FAILED' });
        const r = await ctx.container.finance.summary.reconcile(A.club.id, { conn: trx });
        throw Object.assign(new Error('rollback'), { r });
      })
      .catch((e) => e.r);
    expect(outcome.ok).toBe(false);
    expect(outcome.mismatches.map((m) => m.check)).toEqual(['a', 'd']);
    expect(outcome.mismatches[1]).toMatchObject({ sourceType: 'PAYMENT', sourceId: duesPaymentId });
  });

  it('reconciliation and transactions are CH/TR only', async () => {
    expect((await (await ctx.signIn(volunteer.id)).get(`/api/v1/clubs/${A.club.id}/finance/reconciliation`)).status).toBe(403);
    expect((await (await ctx.signIn(B.head.id)).get(`/api/v1/clubs/${A.club.id}/finance/reconciliation`)).status).toBe(404);
  });

  it('validation of finance queries', async () => {
    const tr = await ctx.signIn(A.treasurer.id);
    expect((await tr.get(`/api/v1/clubs/${A.club.id}/finance/summary?from=2026-11-01&to=2026-10-01`)).status).toBe(400);
    expect((await tr.get(`/api/v1/clubs/${A.club.id}/transactions?category=REFUND`)).status).toBe(400);
    expect((await tr.get(`/api/v1/clubs/${A.club.id}/finance/summary?from=2026-02-30`)).status).toBe(400);
  });
});
