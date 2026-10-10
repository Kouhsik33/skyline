import { todayIST } from '../../shared/clock.js';
import { withTransaction } from '../../db/transaction.js';

export function createAutopayRenewalsJob({
  db,
  membershipRepository,
  paymentService,
  authService,
  notificationService: _notificationService,
}) {
  return {
    name: 'autopay-renewals',
    async execute() {
      const today = todayIST();
      const due = await db('memberships')
        .where({ autopay_enabled: true, status: 'ACTIVE', expires_on: today })
        .select('*');

      let processed = 0;
      for (const m of due) {
        await withTransaction(async (trx) => {
          const [attempt] = await trx('renewal_attempts')
            .insert({
              membership_id: m.id,
              for_expires_on: m.expires_on,
              status: 'PROCESSING',
            })
            .onConflict(['membership_id', 'for_expires_on'])
            .ignore()
            .returning('*');
          if (!attempt) return;

          const verified = await authService.isVerifiedStudent(m.user_id);
          const plan = await membershipRepository.findPlan(m.autopay_plan_id, trx);
          if (
            !verified ||
            !plan ||
            plan.status !== 'ACTIVE' ||
            Number(plan.feePaise) !== Number(m.autopay_amount_paise)
          ) {
            await trx('renewal_attempts')
              .where({ id: attempt.id })
              .update({ status: 'SKIPPED', skip_reason: 'PRICE_CHANGED', completed_at: trx.fn.now() });
            return;
          }

          const pending = await membershipRepository.findPendingPaymentForMembership(m.id, trx);
          if (pending) {
            await trx('renewal_attempts')
              .where({ id: attempt.id })
              .update({ status: 'SKIPPED', skip_reason: 'PAYMENT_ALREADY_PENDING', completed_at: trx.fn.now() });
            return;
          }

          const term = await membershipRepository.insertTerm(
            {
              membership_id: m.id,
              club_id: m.club_id,
              user_id: m.user_id,
              kind: 'RENEWAL',
              source: 'AUTOPAY',
              plan_id: plan.id,
              plan_name: plan.name,
              fee_paise: plan.feePaise,
              duration_months: plan.durationMonths,
              event_discount_bps: plan.eventDiscountBps,
              merch_discount_bps: plan.merchDiscountBps,
              early_bird_access: plan.earlyBirdAccess,
              benefits_text: plan.benefitsText ?? '',
              status: 'PENDING_PAYMENT',
            },
            trx,
          );

          await trx('renewal_attempts').where({ id: attempt.id }).update({ term_id: term.id });

          const payment = await paymentService.create(
            {
              clubId: m.club_id,
              userId: m.user_id,
              purpose: 'MEMBERSHIP_RENEWAL',
              membershipTermId: term.id,
              amountPaise: Number(plan.feePaise),
              method: 'SIMULATED_AUTOPAY',
            },
            trx,
          );

          await trx('renewal_attempts').where({ id: attempt.id }).update({ payment_id: payment.id });

          const outcome = paymentService.decideAutopayOutcome();
          if (outcome === 'PENDING') {
            await trx('payments').where({ id: payment.id }).update({ status: 'PENDING' });
            await trx('renewal_attempts').where({ id: attempt.id }).update({ status: 'PENDING' });
          } else {
            await paymentService.settle(payment.id, outcome, trx, {
              failureReason: outcome === 'FAILED' ? 'AUTOPAY_FAILED' : undefined,
            });
          }
          processed += 1;
        });
      }
      return { processed };
    },
  };
}
