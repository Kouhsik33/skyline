import { AppError, assertFound } from '../../shared/errors.js';
import { withTransaction } from '../../db/transaction.js';
import { randomToken } from '../../shared/tokens.js';
import { todayIST } from '../../shared/clock.js';
import { buildMembershipQrPayload, renderQrSvg } from '../../shared/qr.js';
import { canRegister, canRenew, effectiveMembershipStatus } from './domain/membershipStateMachine.js';
import { computeTermDates } from './domain/termDates.js';

function planSnapshot(plan) {
  return {
    plan_id: plan.id,
    plan_name: plan.name,
    fee_paise: plan.feePaise,
    duration_months: plan.durationMonths,
    event_discount_bps: plan.eventDiscountBps,
    merch_discount_bps: plan.merchDiscountBps,
    early_bird_access: plan.earlyBirdAccess,
    benefits_text: plan.benefitsText ?? '',
  };
}

export function createMembershipService({
  membershipRepository,
  paymentService,
  authService,
  authz: _authz,
  clubRepository,
}) {
  async function assertVerified(userId) {
    if (!(await authService.isVerifiedStudent(userId))) {
      throw new AppError('NOT_VERIFIED', 403, 'Verified student required');
    }
  }

  async function assertPlanAvailable(plan, clubId, expectedFee) {
    if (!plan || plan.clubId !== clubId || plan.status !== 'ACTIVE') {
      throw new AppError('PLAN_NOT_AVAILABLE', 422, 'Plan not available');
    }
    if (Number(plan.feePaise) !== Number(expectedFee)) {
      throw new AppError('PRICE_CHANGED', 409, 'Plan fee changed', { feePaise: Number(plan.feePaise) });
    }
  }

  async function activateFreeTerm(trx, membership, term, plan) {
    const { startsOn, endsOn } = computeTermDates(membership, plan.durationMonths);
    await trx('membership_terms')
      .where({ id: term.id })
      .update({ status: 'PAID', starts_on: startsOn, ends_on: endsOn, paid_at: trx.fn.now() });
    let memberNumber = membership.memberNumber;
    if (!memberNumber) {
      memberNumber = await clubRepository.allocateMemberNumber(membership.clubId, trx);
    }
    await trx('memberships')
      .where({ id: membership.id })
      .update({
        status: 'ACTIVE',
        member_number: memberNumber,
        current_plan_id: plan.id,
        started_on: membership.startedOn ?? startsOn,
        expires_on: endsOn,
      });
    return { membership: await membershipRepository.findMembershipById(membership.id, trx), payment: null };
  }

  return {
    async getActiveBenefits(userId, clubId, dateStr = todayIST()) {
      const membership = await membershipRepository.db('memberships')
        .where({ user_id: userId, club_id: clubId })
        .first();
      if (!membership) return null;
      const eff = effectiveMembershipStatus(membership);
      if (eff !== 'ACTIVE') return null;
      const term = await membershipRepository.getPaidTermCoveringDate(membership.id, dateStr);
      if (!term) return null;
      return {
        membershipId: membership.id,
        termId: term.id,
        planName: term.planName,
        eventDiscountBps: term.eventDiscountBps,
        merchDiscountBps: term.merchDiscountBps,
        earlyBirdAccess: term.earlyBirdAccess,
      };
    },

    async register(actor, clubId, planId, expectedFeePaise) {
      await assertVerified(actor.userId);
      const plan = await membershipRepository.findPlan(planId);
      await assertPlanAvailable(plan, clubId, expectedFeePaise);

      return withTransaction(async (trx) => {
        let membership = await membershipRepository.findMembershipForUserClub(actor.userId, clubId, trx);
        const reg = canRegister(membership);
        if (!reg.ok) {
          if (reg.code === 'PAYMENT_ALREADY_PENDING') {
            const pendingTerm = await membershipRepository.findPendingPaymentForMembership(membership.id, trx);
            const pay = await trx('payments')
              .where({ membership_term_id: pendingTerm.id })
              .whereIn('status', ['INITIATED', 'PENDING'])
              .first();
            throw new AppError('PAYMENT_ALREADY_PENDING', 409, 'Payment already pending', {
              paymentId: pay?.id,
            });
          }
          throw new AppError(reg.code, 409, reg.code);
        }

        if (!membership) {
          membership = await membershipRepository.insertMembership(
            {
              user_id: actor.userId,
              club_id: clubId,
              status: 'PENDING_PAYMENT',
              qr_token: randomToken(16),
            },
            trx,
          );
        } else {
          membership = await membershipRepository.updateMembership(
            membership.id,
            { status: 'PENDING_PAYMENT', updated_at: trx.fn.now() },
            trx,
          );
        }

        const term = await membershipRepository.insertTerm(
          {
            membership_id: membership.id,
            club_id: clubId,
            user_id: actor.userId,
            kind: 'JOIN',
            source: 'MANUAL',
            ...planSnapshot(plan),
            status: 'PENDING_PAYMENT',
          },
          trx,
        );

        if (Number(plan.feePaise) === 0) {
          const result = await activateFreeTerm(trx, membership, term, plan);
          return { membership: result.membership, term, payment: null };
        }

        const payment = await paymentService.create(
          {
            clubId,
            userId: actor.userId,
            purpose: 'MEMBERSHIP_JOIN',
            membershipTermId: term.id,
            amountPaise: Number(plan.feePaise),
          },
          trx,
        );

        return { membership, term, payment };
      });
    },

    async renew(actor, membershipId, planId, expectedFeePaise) {
      await assertVerified(actor.userId);
      const membership = await membershipRepository.findMembershipById(membershipId);
      assertFound(membership, 'Membership not found');
      if (membership.userId !== actor.userId) {
        throw new AppError('FORBIDDEN', 403, 'Forbidden');
      }
      const renewCheck = canRenew(membership);
      if (!renewCheck.ok) {
        throw new AppError(renewCheck.code, 409, renewCheck.code);
      }

      const plan = await membershipRepository.findPlan(planId);
      await assertPlanAvailable(plan, membership.clubId, expectedFeePaise);

      return withTransaction(async (trx) => {
        const locked = await membershipRepository.findMembershipForUserClub(
          actor.userId,
          membership.clubId,
          trx,
        );
        const term = await membershipRepository.insertTerm(
          {
            membership_id: locked.id,
            club_id: locked.clubId,
            user_id: actor.userId,
            kind: 'RENEWAL',
            source: 'MANUAL',
            ...planSnapshot(plan),
            status: 'PENDING_PAYMENT',
          },
          trx,
        );

        if (Number(plan.feePaise) === 0) {
          const result = await activateFreeTerm(trx, locked, term, plan);
          return { term, payment: null, membership: result.membership };
        }

        const payment = await paymentService.create(
          {
            clubId: locked.clubId,
            userId: actor.userId,
            purpose: 'MEMBERSHIP_RENEWAL',
            membershipTermId: term.id,
            amountPaise: Number(plan.feePaise),
          },
          trx,
        );
        return { term, payment, membership: locked };
      });
    },

    async listMine(userId) {
      return membershipRepository.listMyMemberships(userId);
    },

    async getDigitalId(userId, membershipId) {
      const membership = await membershipRepository.findMembershipById(membershipId);
      assertFound(membership, 'Not found');
      if (membership.userId !== userId) throw new AppError('FORBIDDEN', 403, 'Forbidden');
      const eff = effectiveMembershipStatus(membership);
      if (!['ACTIVE', 'EXPIRED'].includes(eff) && !membership.memberNumber) {
        throw new AppError('MEMBERSHIP_NEVER_ACTIVATED', 422, 'Membership never activated');
      }
      const club = await clubRepository.findById(membership.clubId);
      const plan = membership.currentPlanId
        ? await membershipRepository.findPlan(membership.currentPlanId)
        : null;
      const user = await authService.getUserPublic(userId);
      const qrPayload = buildMembershipQrPayload(membership.qrToken);
      const qrSvg = await renderQrSvg(qrPayload);
      return {
        memberName: user?.fullName,
        clubName: club?.name,
        memberNumber: membership.memberNumber,
        planName: plan?.name,
        effectiveStatus: eff,
        expiresOn: membership.expiresOn,
        qrPayload,
        qrSvg,
      };
    },

    async rotateDigitalId(userId, membershipId) {
      const membership = await membershipRepository.findMembershipById(membershipId);
      assertFound(membership, 'Not found');
      if (membership.userId !== userId) throw new AppError('FORBIDDEN', 403, 'Forbidden');
      const token = randomToken(16);
      await membershipRepository.updateMembership(membershipId, { qr_token: token });
      return this.getDigitalId(userId, membershipId);
    },

    async verifyMembershipQr(actorUserId, qrPayload, _requestId) {
      const { parseMembershipQrPayload } = await import('../../shared/qr.js');
      const token = parseMembershipQrPayload(qrPayload);
      if (!token) throw new AppError('INVALID_QR_FORMAT', 400, 'Invalid QR format');
      const membership = await membershipRepository.findByQrToken(token);
      assertFound(membership, 'Not found');
      // Authorization checked in controller via TEAM/STAFF
      const club = await clubRepository.findById(membership.clubId);
      const plan = membership.currentPlanId
        ? await membershipRepository.findPlan(membership.currentPlanId)
        : null;
      const user = await authService.getUserPublic(membership.userId);
      return {
        memberName: user?.fullName,
        clubName: club?.name,
        memberNumber: membership.memberNumber,
        planName: plan?.name,
        effectiveStatus: effectiveMembershipStatus(membership),
        expiresOn: membership.expiresOn,
      };
    },
  };
}
