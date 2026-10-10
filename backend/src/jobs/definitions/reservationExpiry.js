// reservation-expiry (LLD §7, every minute; OQ-09): expire open payments whose hold has passed.
//   SIMULATED payments (INITIATED/PENDING) older than RESERVATION_HOLD_MINUTES
//   SIMULATED_AUTOPAY payments still open after AUTOPAY_PENDING_TIMEOUT_HOURS
// Each payment is settled EXPIRED in its own transaction; the purpose handler releases the hold
// (orders: stock — Group 2; bookings/terms — Group 1 handlers). One failure does not stop others.

export function createReservationExpiryJob({ payments, withTransaction, config, logger }) {
  return async function run({ now }) {
    const due = await payments.listExpirable({
      now,
      holdMinutes: config.reservationHoldMinutes,
      autopayTimeoutHours: config.autopayPendingTimeoutHours,
    });
    const summary = { due: due.length, expired: 0, skipped: 0, failed: 0 };
    for (const payment of due) {
      try {
        const { settled } = await withTransaction((trx) => payments.settle(payment.id, 'EXPIRED', trx, { reason: 'EXPIRED' }));
        summary[settled ? 'expired' : 'skipped'] += 1;
      } catch (err) {
        summary.failed += 1;
        logger.error({ err, paymentId: payment.id, purpose: payment.purpose }, 'reservation-expiry: settle failed');
      }
    }
    return summary;
  };
}
