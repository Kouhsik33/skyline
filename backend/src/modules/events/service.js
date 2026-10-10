import { AppError, assertFound } from '../../shared/errors.js';
import { withTransaction } from '../../db/transaction.js';
import { config } from '../../config/index.js';
import { now } from '../../shared/clock.js';
import { parseTicketQrPayload } from '../../shared/qr.js';
import { assertTransition } from './domain/eventStateMachine.js';
import { deriveSalesStatus } from './domain/salesWindow.js';
import { PRICE_TIERS } from '../pricing/PricingPolicy.js';
import { randomToken, ticketCode } from '../../shared/tokens.js';
import { parsePagination, paginatedResponse } from '../../shared/pagination.js';
import { presentEvent } from './eventPresenter.js';

export function createEventService({
  eventRepository,
  membershipService,
  pricingPolicy,
  paymentService,
  authz,
  config: appConfig,
}) {
  const holdMinutes = appConfig?.RESERVATION_HOLD_MINUTES ?? config.RESERVATION_HOLD_MINUTES;

  return {
    async listEvents(query) {
      const { page, pageSize, offset } = parsePagination(query, { page: 1, pageSize: 20, maxPageSize: 100 });
      const { rows, total } = await eventRepository.listPublished({
        clubId: query.clubId,
        q: query.q,
        includePast: query.includePast,
        offset,
        limit: pageSize,
      });
      const ticketCounts = await eventRepository.countTicketsForEvents(rows.map((r) => r.id));
      const data = rows.map((row) =>
        presentEvent(
          { ...row, clubId: row.clubId },
          {
            clubName: row.clubName ?? null,
            clubSlug: row.clubSlug ?? null,
            ticketsSold: ticketCounts[row.id] ?? 0,
            organizers: [],
            pricingPolicy,
          },
        ),
      );
      return paginatedResponse(data, page, pageSize, total);
    },

    async getEvent(eventId) {
      const event = await eventRepository.findById(eventId);
      assertFound(event, 'Event not found');
      const club = await eventRepository.db('clubs').where({ id: event.clubId }).first();
      const ticketsSold = await eventRepository.db('tickets')
        .where({ event_id: eventId })
        .whereNot({ status: 'CANCELLED' })
        .count('* as c')
        .first();
      const orgRows = await eventRepository.db('event_organizers as o')
        .join('users as u', 'u.id', 'o.user_id')
        .where('o.event_id', eventId)
        .select('o.user_id', 'u.full_name');
      return presentEvent(event, {
        clubName: club?.name ?? null,
        clubSlug: club?.slug ?? null,
        ticketsSold: Number(ticketsSold?.c ?? 0),
        organizers: orgRows.map((o) => ({ userId: o.user_id, fullName: o.full_name })),
        pricingPolicy,
      });
    },

    async quote(actor, eventId) {
      const event = await eventRepository.findById(eventId);
      assertFound(event, 'Event not found');
      const benefits = actor?.userId
        ? await membershipService.getActiveBenefits(actor.userId, event.clubId)
        : null;
      const ebRemaining =
        event.earlyBirdQuantity == null
          ? null
          : event.earlyBirdQuantity - event.earlyBirdReserved;
      try {
        const quote = pricingPolicy.quoteTicket(event, benefits, ebRemaining);
        const salesStatus = deriveSalesStatus(
          event,
          benefits?.earlyBirdAccess,
          now(),
          pricingPolicy,
        );
        return {
          eligible: true,
          buyerType: benefits ? 'MEMBER' : 'NON_MEMBER',
          priceTier: quote.tier,
          listPricePaise: quote.list,
          discountPaise: quote.disc,
          finalPricePaise: quote.final,
          salesStatus,
          pricingMode: pricingPolicy.combinationMode,
          usesEarlyBird: quote.usesEarlyBird ?? false,
        };
      } catch (err) {
        if (err instanceof AppError) {
          return { eligible: false, reason: err.code, message: err.message };
        }
        throw err;
      }
    },

    async book(actor, eventId, expectedFinalPricePaise) {
      // Benefits are read BEFORE the transaction: getActiveBenefits uses its own pool connection,
      // and calling it while holding the event row lock serialised bookings and starved the pool
      // under concurrency (T-90 / TC-EVT-01, same class as OQ-59).
      const eventForClub = await eventRepository.findById(eventId);
      assertFound(eventForClub, 'Event not found');
      const benefits = await membershipService.getActiveBenefits(actor.userId, eventForClub.clubId);

      return withTransaction(async (trx) => {
        const existing = await eventRepository.findLiveBooking(eventId, actor.userId, trx);
        if (existing) throw new AppError('ALREADY_BOOKED', 409, 'Already booked');

        const event = await eventRepository.findForUpdate(eventId, trx);
        assertFound(event, 'Event not found');

        const ebRemaining =
          event.earlyBirdQuantity == null
            ? null
            : event.earlyBirdQuantity - event.earlyBirdReserved;

        const quote = pricingPolicy.quoteTicket(event, benefits, ebRemaining);

        if (quote.final !== expectedFinalPricePaise) {
          throw new AppError('PRICE_CHANGED', 409, 'Price changed', {
            quote: {
              finalPricePaise: quote.final,
              priceTier: quote.tier,
            },
          });
        }

        const usesEarlyBird = quote.usesEarlyBird ?? false;
        const reserved = await eventRepository.reserveSeat(eventId, usesEarlyBird, trx);
        if (!reserved) {
          throw new AppError('SOLD_OUT', 409, 'Sold out');
        }

        const holdExpiresAt =
          quote.final > 0 ? new Date(now().getTime() + holdMinutes * 60 * 1000) : null;

        const booking = await eventRepository.insertBooking(
          {
            event_id: eventId,
            club_id: event.clubId,
            user_id: actor.userId,
            status: quote.final === 0 ? 'CONFIRMED' : 'PENDING_PAYMENT',
            buyer_type: benefits ? 'MEMBER' : 'NON_MEMBER',
            price_tier: quote.final === 0 ? PRICE_TIERS.FREE : quote.tier,
            list_price_paise: quote.list,
            discount_paise: quote.disc,
            final_price_paise: quote.final,
            pricing_mode: pricingPolicy.combinationMode,
            membership_term_id: benefits?.termId ?? null,
            uses_early_bird: usesEarlyBird,
            hold_expires_at: holdExpiresAt,
            confirmed_at: quote.final === 0 ? now() : null,
          },
          trx,
        );

        let payment = null;
        let ticket = null;

        if (quote.final === 0) {
          ticket = await eventRepository.insertTicket(
            {
              booking_id: booking.id,
              event_id: eventId,
              club_id: event.clubId,
              user_id: actor.userId,
              ticket_code: ticketCode(),
              qr_token: randomToken(16),
              status: 'VALID',
            },
            trx,
          );
        } else {
          payment = await paymentService.create(
            {
              clubId: event.clubId,
              userId: actor.userId,
              purpose: 'EVENT_TICKET',
              bookingId: booking.id,
              amountPaise: quote.final,
            },
            trx,
          );
        }

        return { booking, payment, ticket };
      });
    },

    async checkIn(actor, eventId, qrPayload) {
      const token = parseTicketQrPayload(qrPayload);
      if (!token) {
        throw new AppError('INVALID_QR_FORMAT', 400, 'Invalid ticket QR (membership cards use a different endpoint)');
      }

      const allowed =
        (await authz.isStaff(actor.userId, eventId)) ||
        (await authz.isOrganizer(actor.userId, eventId)) ||
        (await authz.eventClubId(eventId).then((cid) => authz.isClubHead(actor.userId, cid)));
      if (!allowed) throw new AppError('NOT_EVENT_STAFF', 403, 'Not event staff');

      const event = await eventRepository.findById(eventId);
      if (event.status !== 'PUBLISHED') {
        throw new AppError('EVENT_NOT_ACTIVE', 422, 'Event not active');
      }

      return withTransaction(async (trx) => {
        const [updated] = await trx('tickets')
          .where({ qr_token: token, event_id: eventId, status: 'VALID' })
          .update({ status: 'USED', used_at: now(), used_by: actor.userId })
          .returning('*');

        if (updated) {
          await trx('check_ins').insert({
            ticket_id: updated.id,
            event_id: eventId,
            checked_in_by: actor.userId,
          });
          const user = await trx('users').where({ id: updated.user_id }).first();
          return {
            result: 'CHECKED_IN',
            ticketCode: updated.ticket_code,
            holderName: user.full_name,
            buyerType: (await trx('bookings').where({ id: updated.booking_id }).first()).buyer_type,
            checkedInAt: updated.used_at,
          };
        }

        const ticket = await eventRepository.findTicketByQrToken(token, trx);
        if (!ticket) throw new AppError('TICKET_NOT_FOUND', 404, 'Ticket not found');
        if (ticket.eventId !== eventId) throw new AppError('TICKET_WRONG_EVENT', 409, 'Wrong event');
        if (ticket.status === 'USED') {
          throw new AppError('TICKET_ALREADY_USED', 409, 'Ticket already used', {
            usedAt: ticket.usedAt,
          });
        }
        if (ticket.status === 'CANCELLED') throw new AppError('TICKET_CANCELLED', 409, 'Ticket cancelled');
        throw new AppError('TICKET_NOT_FOUND', 404, 'Ticket not found');
      });
    },

    async createEvent(actor, clubId, dto) {
      await authz.requireClubHead(actor.userId, clubId);
      return eventRepository.insert(
        {
          club_id: clubId,
          title: dto.title,
          description: dto.description ?? '',
          venue: dto.venue,
          starts_at: dto.startsAt,
          ends_at: dto.endsAt,
          registration_opens_at: dto.registrationOpensAt,
          registration_closes_at: dto.registrationClosesAt,
          early_access_opens_at: dto.earlyAccessOpensAt ?? null,
          capacity: dto.capacity,
          member_price_paise: dto.memberPricePaise,
          non_member_price_paise: dto.nonMemberPricePaise ?? null,
          member_discount_eligible: dto.memberDiscountEligible ?? true,
          early_bird_member_price_paise: dto.earlyBirdMemberPricePaise ?? null,
          early_bird_non_member_price_paise: dto.earlyBirdNonMemberPricePaise ?? null,
          early_bird_ends_at: dto.earlyBirdEndsAt ?? null,
          early_bird_quantity: dto.earlyBirdQuantity ?? null,
          status: 'DRAFT',
          created_by: actor.userId,
        },
        eventRepository.db,
      );
    },

    async publish(actor, eventId) {
      const event = await eventRepository.findById(eventId);
      assertFound(event, 'Event not found');
      await authz.requireClubHead(actor.userId, event.clubId);
      const orgs = await eventRepository.db('event_organizers').where({ event_id: eventId });
      if (orgs.length === 0) throw new AppError('ORGANIZER_REQUIRED', 422, 'Organizer required');
      assertTransition(event.status, 'publish');
      return eventRepository.update(
        eventId,
        { status: 'PUBLISHED', published_at: now() },
        eventRepository.db,
      );
    },
  };
}
