import { AppError, appError } from '../errors.js';
import { logger } from '../logger.js';

// One error envelope for both groups (LLD §4.0, §9):
//   { error: { code, message, details, requestId } } — never a stack trace.
// Unique-violation constraint names map to documented domain codes; body-parser errors are 400;
// anything unknown is a logged 500 INTERNAL_ERROR.

// Constraint name -> domain code (A2). Live-payment indexes from 009 (pay_live_*) and 014
// (payments_live_*_uq) all mean "a payment for this target is already in progress".
export const UNIQUE_VIOLATION_CODES = Object.freeze({
  payments_live_order_uq: 'PAYMENT_ALREADY_PENDING',
  payments_live_booking_uq: 'PAYMENT_ALREADY_PENDING',
  payments_live_membership_term_uq: 'PAYMENT_ALREADY_PENDING',
  payments_succeeded_order_uq: 'PAYMENT_ALREADY_PENDING',
  pay_live_booking: 'PAYMENT_ALREADY_PENDING',
  pay_live_term: 'PAYMENT_ALREADY_PENDING',
  product_categories_club_name_uq: 'CATEGORY_NAME_TAKEN',
  product_variants_product_id_size_label_key: 'SIZE_EXISTS',
});

function toAppError(err) {
  if (err instanceof AppError) return err;
  if (err?.name === 'ZodError') {
    return appError('VALIDATION_FAILED', { fields: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }, 'Validation failed');
  }
  if (err?.type === 'entity.parse.failed') return appError('VALIDATION_FAILED', { fields: [{ path: '', message: 'Malformed JSON body' }] }, 'Validation failed');
  if (err?.type === 'entity.too.large') return appError('VALIDATION_FAILED', { fields: [{ path: '', message: 'Request body too large' }] }, 'Validation failed');
  if (err?.code === '23505' && UNIQUE_VIOLATION_CODES[err.constraint]) return appError(UNIQUE_VIOLATION_CODES[err.constraint]);
  return null;
}

export function notFoundHandler(_req, _res, next) {
  next(appError('NOT_FOUND'));
}

export function errorHandler(err, req, res, _next) {
  const requestId = req.requestId || 'unknown';
  let appErr = toAppError(err);
  if (!appErr || appErr.httpStatus >= 500) {
    logger.error({ err, requestId, code: appErr?.code ?? 'INTERNAL_ERROR' }, 'Unhandled error');
    appErr = appErr && appErr.code !== 'INTERNAL_ERROR' ? appErr : new AppError('INTERNAL_ERROR', 500, 'An unexpected error occurred', {});
  }
  if (res.headersSent) return undefined;
  return res.status(appErr.httpStatus).json({
    error: { code: appErr.code, message: appErr.message, details: appErr.details ?? {}, requestId },
  });
}
