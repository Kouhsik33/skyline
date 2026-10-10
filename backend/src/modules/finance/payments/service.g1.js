// G2-STUB: Group 1 owns settle/create/simulate; Group 2 may extend simulator/routes.
import { AppError, assertFound } from '../../../shared/errors.js';
import { randomReference } from '../../../shared/tokens.js';
import { withTransaction } from '../../../db/transaction.js';
import { toCamelCase } from '../../../shared/caseMap.js';

/**
 * @typedef {{ purpose: string, onSucceeded: Function, onFailed: Function }} PaymentPurposeHandler
 */

export function createPaymentService({ paymentRepository, handlerRegistry, ledgerService: _ledgerService, config }) {
  const terminal = new Set(['SUCCEEDED', 'FAILED', 'EXPIRED']);

  async function create(input, trx) {
    const row = {
      club_id: input.clubId,
      user_id: input.userId,
      purpose: input.purpose,
      membership_term_id: input.membershipTermId ?? null,
      booking_id: input.bookingId ?? null,
      order_id: input.orderId ?? null,
      amount_paise: input.amountPaise,
      method: input.method ?? 'SIMULATED',
      is_simulated: true,
      status: 'INITIATED',
      reference: randomReference('SIM'),
    };
    return paymentRepository.insert(row, trx);
  }

  async function settle(paymentId, outcome, trx, options = {}) {
    if (!['SUCCEEDED', 'FAILED', 'EXPIRED', 'PENDING'].includes(outcome)) {
      throw new AppError('VALIDATION_FAILED', 400, 'Invalid outcome');
    }

    const existing = await paymentRepository.findByIdForUpdate(paymentId, trx);
    assertFound(existing, 'Payment not found');
    if (terminal.has(existing.status)) {
      return { payment: existing, handlerResult: null, settled: false };
    }

    if (outcome === 'PENDING') {
      const [updated] = await trx('payments')
        .where({ id: paymentId })
        .whereIn('status', ['INITIATED', 'PENDING'])
        .update({ status: 'PENDING', updated_at: trx.fn.now() })
        .returning('*');
      if (!updated) return { payment: existing, handlerResult: null, settled: false };
      return { payment: toCamelCase(updated), handlerResult: null, settled: true };
    }

    const failureReason = options.failureReason ?? (outcome === 'FAILED' ? 'SIMULATED_FAILED' : 'EXPIRED');
    const updated = await paymentRepository.settle(
      paymentId,
      outcome,
      outcome === 'FAILED' || outcome === 'EXPIRED' ? failureReason : null,
      trx,
    );
    if (!updated) {
      const current = await paymentRepository.findById(paymentId, trx);
      return { payment: current, handlerResult: null, settled: false };
    }

    const handler = handlerRegistry.get(updated.purpose);
    let handlerResult = null;
    if (outcome === 'SUCCEEDED') {
      handlerResult = await handler.onSucceeded(updated, trx);
    } else {
      await handler.onFailed(updated, failureReason, trx);
    }
    return { payment: updated, handlerResult, settled: true };
  }

  async function simulate(actorUserId, paymentId, outcome) {
    return withTransaction(async (trx) => {
      const payment = await paymentRepository.findByIdForUpdate(paymentId, trx);
      assertFound(payment, 'Payment not found');
      // Someone else's payment does not exist for the caller (LLD §4.0: not owned -> 404).
      if (payment.userId !== actorUserId) {
        throw new AppError('NOT_FOUND', 404, 'Payment not found');
      }
      if (payment.method === 'SIMULATED_AUTOPAY') {
        throw new AppError('FORBIDDEN', 403, 'Use dev tools for AutoPay payments', { reason: 'AUTOPAY_PAYMENT' });
      }
      if (terminal.has(payment.status)) {
        return { payment, result: null };
      }

      const { payment: settledPayment, handlerResult } = await settle(paymentId, outcome, trx, {
        failureReason: outcome === 'FAILED' ? 'USER_SIMULATED_FAIL' : undefined,
      });
      return { payment: settledPayment, result: handlerResult };
    });
  }

  function decideAutopayOutcome() {
    return config.SIM_AUTOPAY_OUTCOME ?? 'SUCCEEDED';
  }

  return {
    create,
    settle,
    simulate,
    decideAutopayOutcome,
    async getPayment(actorUserId, paymentId) {
      const payment = await paymentRepository.findById(paymentId);
      assertFound(payment, 'Payment not found');
      if (payment.userId !== actorUserId) {
        throw new AppError('NOT_FOUND', 404, 'Payment not found');
      }
      return payment;
    },

    async listMine(userId, query = {}) {
      const page = Math.max(1, Number(query.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
      const filters = { purpose: query.purpose, status: query.status };
      const rows = await paymentRepository.listByUser(userId, { ...filters, limit: pageSize, offset: (page - 1) * pageSize });
      const total = await paymentRepository.countByUser(userId, filters);
      return { data: rows, page, pageSize, total };
    },
  };
}
