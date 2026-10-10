import { appError } from '../../../shared/errors.js';
import { UNIQUE_VIOLATION_CODES } from '../../../shared/middleware/errorHandler.js';
import { paymentReference } from '../../../shared/tokens.js';
import { toOffset } from '../../../shared/pagination.js';
import { OPEN_STATUSES, SETTLE_OUTCOMES, planSimulation, validateNewPayment } from '../domain/paymentStateMachine.js';
import * as repository from './repository.js';

// Simulated payments (LLD §2.10, §4.4, §5). No real money, no external calls: is_simulated is
// always true (column default + CHECK) and is never taken from a caller.

const REFERENCE_ATTEMPTS = 3;

export function createPaymentService({ db, withTransaction, clock, registry, timeZone, logger }) {
  /**
   * create(trx, {clubId, userId, purpose, membershipTermId|bookingId|orderId, amountPaise, method})
   * Called inside the caller's transaction (booking, order, membership join/renewal, AutoPay).
   * amountPaise must be the server-computed price.
   */
  async function create(trx, input) {
    if (!trx) throw new TypeError('payments.create requires a transaction');
    const method = input.method ?? 'SIMULATED';
    const problems = validateNewPayment({ ...input, method });
    if (problems.length) throw new TypeError(`Invalid payment: ${problems.join('; ')}`);

    for (let attempt = 1; ; attempt += 1) {
      const reference = paymentReference();
      try {
        // A savepoint keeps a reference collision from aborting the caller's transaction.
        return await trx.transaction((sp) =>
          repository.insert(sp, {
            club_id: input.clubId,
            user_id: input.userId,
            purpose: input.purpose,
            membership_term_id: input.membershipTermId ?? null,
            booking_id: input.bookingId ?? null,
            order_id: input.orderId ?? null,
            amount_paise: input.amountPaise,
            method,
            status: 'INITIATED',
            reference,
            // From the injectable clock: hold expiry is measured from created_at (OQ-09).
            created_at: clock.now(),
          }),
        );
      } catch (err) {
        if (err?.code === '23505' && /^payments_reference_(key|unique)$/.test(err.constraint ?? '') && attempt < REFERENCE_ATTEMPTS) continue;
        if (err?.code === '23505' && UNIQUE_VIOLATION_CODES[err.constraint] === 'PAYMENT_ALREADY_PENDING') throw appError('PAYMENT_ALREADY_PENDING');
        throw err;
      }
    }
  }

  /**
   * settle(paymentId, outcome, trx, {reason}) -> {payment, settled, result}   (LLD §2.10, OQ-13)
   * outcome: SUCCEEDED | FAILED | EXPIRED. The handler (and, through it, ledger.post) runs only
   * when the conditional UPDATE returned a row, in the same transaction. Otherwise the current
   * row is returned unchanged with settled=false.
   */
  async function settle(paymentId, outcome, trx, { reason } = {}) {
    if (!trx) throw new TypeError('payments.settle requires a transaction');
    if (!SETTLE_OUTCOMES.includes(outcome)) throw new TypeError(`unknown settle outcome ${outcome}`);
    const failureReason = outcome === 'SUCCEEDED' ? null : (reason ?? outcome);

    const updated = await repository.settleIfOpen(trx, paymentId, { status: outcome, failureReason, settledAt: clock.now() });
    if (!updated) {
      const current = await repository.findById(trx, paymentId);
      if (!current) throw appError('NOT_FOUND');
      return { payment: current, settled: false, result: null };
    }

    const handler = registry.get(updated.purpose);
    const result =
      outcome === 'SUCCEEDED' ? await handler.onSucceeded(updated, trx) : await handler.onFailed(updated, failureReason, trx);
    logger.info({ paymentId, purpose: updated.purpose, outcome }, 'payment settled');
    return { payment: updated, settled: true, result: result ?? null };
  }

  async function getById(paymentId, trx) {
    return repository.findById(trx ?? db, paymentId);
  }

  /** Owner-only read; another user's payment is NOT_FOUND. */
  async function getForOwner(actor, paymentId) {
    const payment = await repository.findById(db, paymentId);
    if (!payment || payment.user_id !== actor.userId) throw appError('NOT_FOUND');
    return payment;
  }

  /**
   * POST /payments/:id/simulate (owner) and POST /dev/payments/:id/simulate (devOverride).
   * Terminal payments come back unchanged; PENDING -> PENDING is a no-op (OQ-32).
   */
  async function simulate(actor, paymentId, outcome, { devOverride = false } = {}) {
    return withTransaction(async (trx) => {
      const payment = await repository.findById(trx, paymentId);
      if (!payment || (!devOverride && payment.user_id !== actor.userId)) throw appError('NOT_FOUND');

      const action = planSimulation(payment, outcome, { devOverride });
      if (action === 'FORBIDDEN') throw appError('FORBIDDEN', { reason: 'AUTOPAY_PAYMENT' });
      if (action === 'NOOP') return { payment, result: null };
      if (action === 'MARK_PENDING') {
        const pending = await repository.markPendingIfInitiated(trx, paymentId);
        return { payment: pending ?? (await repository.findById(trx, paymentId)), result: null };
      }
      const { payment: settledPayment, result } = await settle(paymentId, outcome, trx);
      return { payment: settledPayment, result };
    });
  }

  // from/to are IST calendar dates (inclusive); the repository turns them into instants.
  const toFilters = ({ purpose, status, from, to }) => ({ purpose, status, from, to, timeZone });

  async function listMine(actor, query) {
    const { rows, total } = await repository.listByUser(db, actor.userId, toFilters(query), {
      limit: query.pageSize,
      offset: toOffset(query),
    });
    return { rows, total };
  }

  async function listForClub(clubId, query) {
    const { rows, total } = await repository.listByClub(db, clubId, toFilters(query), {
      limit: query.pageSize,
      offset: toOffset(query),
    });
    return { rows, total };
  }

  return Object.freeze({
    listExpirable: (opts) => repository.listExpirable(db, opts),
    findOpenByOrder: (orderId, trx) => repository.findOpenByOrder(trx ?? db, orderId),
    listByOrder: (orderId) => repository.listByOrder(db, orderId),
    latestByOrders: (orderIds) => repository.latestByOrders(db, orderIds),
    create,
    settle,
    getById,
    getForOwner,
    simulate,
    listMine,
    listForClub,
    registerHandler: registry.register,
    isOpen: (payment) => OPEN_STATUSES.includes(payment.status),
  });
}
