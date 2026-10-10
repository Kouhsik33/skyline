import { PAYMENT_PURPOSES } from '../domain/paymentStateMachine.js';
import { toCamelCase, toSnakeCase } from '../../../shared/caseMap.js';

// One PaymentPurposeHandler registry for the whole backend (LLD §2.10). Both payment engines
// (Group 1's service.g1.js and Group 2's service.js) settle the same payments table and dispatch
// through this registry. Group 1 handlers read camelCase rows (payment.amountPaise), Group 2
// handlers snake_case rows (payment.amount_paise), so every handler receives a row carrying both.

export function withBothCases(row) {
  if (row == null) return row;
  const isSnake = Object.prototype.hasOwnProperty.call(row, 'club_id') || Object.prototype.hasOwnProperty.call(row, 'amount_paise');
  const snake = isSnake ? row : toSnakeCase(row);
  const camel = isSnake ? toCamelCase(row) : row;
  return { ...snake, ...camel };
}

export function createHandlerRegistry() {
  const handlers = new Map();

  function register(handler) {
    if (!handler || !PAYMENT_PURPOSES.includes(handler.purpose)) {
      throw new TypeError(`payment handler has unknown purpose: ${handler?.purpose}`);
    }
    if (typeof handler.onSucceeded !== 'function' || typeof handler.onFailed !== 'function') {
      throw new TypeError(`payment handler for ${handler.purpose} must define onSucceeded and onFailed`);
    }
    if (handlers.has(handler.purpose)) throw new Error(`payment handler for ${handler.purpose} is already registered`);
    handlers.set(
      handler.purpose,
      Object.freeze({
        purpose: handler.purpose,
        onSucceeded: (payment, trx) => handler.onSucceeded(withBothCases(payment), trx),
        onFailed: (payment, reason, trx) => handler.onFailed(withBothCases(payment), reason, trx),
      }),
    );
  }

  function get(purpose) {
    const handler = handlers.get(purpose);
    if (!handler) throw new Error(`no payment handler registered for ${purpose}`);
    return handler;
  }

  return Object.freeze({ register, get, purposes: () => [...handlers.keys()] });
}

/** @deprecated Group 1 name — same registry as createHandlerRegistry. */
export const createPaymentHandlerRegistry = createHandlerRegistry;
