// A2 — payments integrity on top of merged 009 (which is not edited):
//   - FK payments.order_id → orders (009 left order_id without one);
//   - one live payment (INITIATED or PENDING) per order, booking and membership term;
//   - at most one SUCCEEDED payment per order (009's pay_live_booking / pay_live_term already
//     cover SUCCEEDED for bookings and terms).
// Index names are mapped to PAYMENT_ALREADY_PENDING by shared/middleware/errorHandler.js.

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE payments
      ADD CONSTRAINT payments_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT;
    CREATE UNIQUE INDEX payments_live_order_uq ON payments (order_id)
      WHERE order_id IS NOT NULL AND status IN ('INITIATED', 'PENDING');
    CREATE UNIQUE INDEX payments_live_booking_uq ON payments (booking_id)
      WHERE booking_id IS NOT NULL AND status IN ('INITIATED', 'PENDING');
    CREATE UNIQUE INDEX payments_live_membership_term_uq ON payments (membership_term_id)
      WHERE membership_term_id IS NOT NULL AND status IN ('INITIATED', 'PENDING');
    CREATE UNIQUE INDEX payments_succeeded_order_uq ON payments (order_id)
      WHERE order_id IS NOT NULL AND status = 'SUCCEEDED';
  `);
}

export async function down(knex) {
  await knex.raw(`
    DROP INDEX payments_succeeded_order_uq;
    DROP INDEX payments_live_membership_term_uq;
    DROP INDEX payments_live_booking_uq;
    DROP INDEX payments_live_order_uq;
    ALTER TABLE payments DROP CONSTRAINT payments_order_id_fkey;
  `);
}
