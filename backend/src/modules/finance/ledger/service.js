import { appError } from '../../../shared/errors.js';
import { PAYMENT_PURPOSE_CATEGORY, samePosting, validateLedgerEntry } from '../domain/ledgerRules.js';
import * as repository from './repository.js';

// ledger.post(trx, entry) — the only writer of financial_transactions (LLD §5.12, ADR-015).
// Posting the same source twice is a no-op when it records the same money; anything else is
// LEDGER_CONFLICT (500 + error log), which rolls the caller's transaction back.

export function createLedgerService({ db, logger }) {
  /**
   * occurredAt is required, except for PAYMENT sources: there it defaults to the payment's
   * settled_at, read in the caller's transaction (OQ-16). Group 1 handlers rely on this.
   */
  async function withOccurredAt(trx, entry) {
    if (entry.occurredAt != null) return { ...entry, occurredAt: entry.occurredAt instanceof Date ? entry.occurredAt : new Date(entry.occurredAt) };
    if (entry.sourceType !== 'PAYMENT' || !entry.paymentId) return entry;
    const payment = await trx('payments').where({ id: entry.paymentId }).first('settled_at');
    return payment?.settled_at ? { ...entry, occurredAt: new Date(payment.settled_at) } : entry;
  }

  async function post(trx, rawEntry) {
    if (!trx) throw new TypeError('ledger.post requires a transaction');
    const entry = await withOccurredAt(trx, rawEntry);
    const problems = validateLedgerEntry(entry);
    if (problems.length) throw new TypeError(`Invalid ledger entry: ${problems.join('; ')}`);

    const inserted = await repository.insertIfAbsent(trx, entry);
    if (inserted) return { transaction: inserted, created: true };

    const existing = await repository.findBySource(trx, entry.sourceType, entry.sourceId);
    if (existing && samePosting(existing, entry)) return { transaction: existing, created: false };
    logger.error(
      { sourceType: entry.sourceType, sourceId: entry.sourceId, existingId: existing?.id ?? null },
      'ledger: source already posted with different money',
    );
    throw appError('LEDGER_CONFLICT');
  }

  /**
   * Income row for a SUCCEEDED payment, for payment purpose handlers (LLD §5.2, §5.7, §5.9).
   * Category follows the purpose; occurredAt is the settlement time (OQ-16).
   */
  async function postPaymentIncome(trx, payment, { description, eventId, membershipId, orderId, fundraiserId } = {}) {
    if (payment.status !== 'SUCCEEDED') throw new TypeError('only SUCCEEDED payments are posted to the ledger');
    return post(trx, {
      clubId: payment.club_id,
      direction: 'IN',
      category: PAYMENT_PURPOSE_CATEGORY[payment.purpose],
      amountPaise: payment.amount_paise,
      sourceType: 'PAYMENT',
      sourceId: payment.id,
      paymentId: payment.id,
      eventId,
      membershipId,
      orderId,
      fundraiserId,
      payerUserId: payment.user_id,
      recordedBy: null,
      description: description ?? `${payment.purpose} ${payment.reference}`,
      reference: payment.reference,
      occurredAt: new Date(payment.settled_at),
    });
  }

  /** Map fundraiserId -> { income, expensesPaid } from ledger sums (zeros when no rows). */
  async function fundraiserMoney(fundraiserIds) {
    const rows = await repository.sumsByFundraiser(db, fundraiserIds);
    const byId = new Map(rows.map((r) => [r.fundraiser_id, { income: r.income, expensesPaid: r.expenses_paid }]));
    return new Map(fundraiserIds.map((id) => [id, byId.get(id) ?? { income: 0, expensesPaid: 0 }]));
  }

  return Object.freeze({ post, postPaymentIncome, fundraiserMoney });
}
