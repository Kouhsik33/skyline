import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestContext } from '../helpers/testApp.js';
import { truncateAll } from '../helpers/testDb.js';
import { makeMembershipPayment } from '../fixtures/factories.js';

// TC-FIN-04 (ledger immutability) and ledger.post() semantics (LLD §5.12).

describe('ledger', () => {
  let ctx;
  beforeAll(() => {
    ctx = buildTestContext();
  });
  afterAll(() => ctx.close());
  beforeEach(() => truncateAll(ctx.db));

  async function settledPaymentWithLedgerRow() {
    const data = await makeMembershipPayment(ctx);
    await ctx.container.withTransaction((trx) => ctx.container.finance.payments.settle(data.payment.id, 'SUCCEEDED', trx));
    const row = await ctx.db('financial_transactions').where({ payment_id: data.payment.id }).first();
    return { ...data, row };
  }

  it('TC-FIN-04: UPDATE and DELETE on financial_transactions raise an exception', async () => {
    const { row } = await settledPaymentWithLedgerRow();
    await expect(ctx.db('financial_transactions').where({ id: row.id }).update({ amount_paise: 1 })).rejects.toThrow(
      /forbidden on financial_transactions/,
    );
    await expect(ctx.db('financial_transactions').where({ id: row.id }).del()).rejects.toThrow(
      /forbidden on financial_transactions/,
    );
    const after = await ctx.db('financial_transactions').where({ id: row.id }).first();
    expect(after.amount_paise).toBe(row.amount_paise);
  });

  it('posting the same source twice keeps one row (ON CONFLICT DO NOTHING) and reports created=false', async () => {
    const { payment, row } = await settledPaymentWithLedgerRow();
    const settled = await ctx.db('payments').where({ id: payment.id }).first();
    const again = await ctx.container.withTransaction((trx) => ctx.container.finance.ledger.postPaymentIncome(trx, settled));
    expect(again.created).toBe(false);
    expect(again.transaction.id).toBe(row.id);
    expect(await ctx.db('financial_transactions').count({ n: '*' }).first()).toEqual({ n: 1 });
  });

  it('same source with different money is LEDGER_CONFLICT and rolls the transaction back', async () => {
    const { payment, club } = await settledPaymentWithLedgerRow();
    const attempt = ctx.container.withTransaction(async (trx) => {
      await trx('audit_logs').insert({ action: 'TEST_MARKER', entity_type: 'test' });
      return ctx.container.finance.ledger.post(trx, {
        clubId: club.id,
        direction: 'IN',
        category: 'MEMBERSHIP_DUES',
        amountPaise: 1,
        sourceType: 'PAYMENT',
        sourceId: payment.id,
        paymentId: payment.id,
        description: 'tampered',
        occurredAt: new Date(),
      });
    });
    await expect(attempt).rejects.toMatchObject({ code: 'LEDGER_CONFLICT', httpStatus: 500 });
    expect(await ctx.db('audit_logs').where({ action: 'TEST_MARKER' }).first()).toBeUndefined();
  });

  it('validates entries before writing (no float, category must match direction)', async () => {
    const { club } = await settledPaymentWithLedgerRow();
    const id = randomUUID();
    const base = {
      clubId: club.id,
      direction: 'IN',
      category: 'FUNDRAISER_INCOME',
      amountPaise: 1000,
      sourceType: 'INCOME_ENTRY',
      sourceId: id,
      description: 'cash box',
      occurredAt: new Date(),
    };
    const post = (entry) => ctx.container.withTransaction((trx) => ctx.container.finance.ledger.post(trx, entry));
    await expect(post({ ...base, amountPaise: 10.5 })).rejects.toThrow(/amountPaise/);
    await expect(post({ ...base, direction: 'OUT' })).rejects.toThrow(/category/);
    await expect(ctx.container.finance.ledger.post(null, base)).rejects.toThrow(/transaction/);
    const ok = await post(base);
    expect(ok.created).toBe(true);
    expect(ok.transaction).toMatchObject({ amount_paise: 1000, status: 'POSTED', currency: 'INR' });
  });

  it('database CHECKs back up the rules (category/direction, amount > 0, source ids)', async () => {
    const { club, payment } = await settledPaymentWithLedgerRow();
    const insert = (row) =>
      ctx.db('financial_transactions').insert({
        club_id: club.id,
        direction: 'IN',
        category: 'TICKET_SALE',
        amount_paise: 100,
        source_type: 'INCOME_ENTRY',
        source_id: randomUUID(),
        description: 'x',
        occurred_at: new Date(),
        ...row,
      });
    await expect(insert({ direction: 'OUT' })).rejects.toThrow(/financial_transactions_category_chk/);
    await expect(insert({ amount_paise: 0 })).rejects.toThrow(/check constraint/);
    await expect(insert({ source_type: 'PAYMENT', payment_id: payment.id })).rejects.toThrow(/check constraint/);
    await expect(insert({ currency: 'USD' })).rejects.toThrow(/check constraint/);
  });
});
