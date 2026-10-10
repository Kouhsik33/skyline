import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestContext, idemKey } from '../helpers/testApp.js';
import { truncateAll } from '../helpers/testDb.js';
import { verifyStudent } from '../helpers/factories.js';
import { pay } from '../helpers/merch.js';
import { makeClub, makeUser } from '../fixtures/factories.js';

// T-90 — shared concurrency suite on the real merged app (Group 1 flows; the Group 2 ones are in
// settle / merch / expenses .concurrency files): TC-EVT-01 bookings vs capacity, TC-CHK-03
// simultaneous scans, TC-AP-02 duplicate AutoPay runs. Reconciliation must hold afterwards.
// Clock 2026-11-01 10:00 IST.

const H = { 'X-Requested-With': 'soms' };

describe('T-90 shared concurrency suite', () => {
  let ctx;
  let club;
  beforeAll(() => {
    ctx = buildTestContext();
  });
  afterAll(async () => {
    const recon = club ? await ctx.container.finance.summary.reconcile(club.club.id) : { ok: true };
    await ctx.close();
    expect(recon.ok).toBe(true);
  });
  beforeEach(async () => {
    await truncateAll(ctx.db);
    club = await makeClub(ctx.db);
  });

  async function publishedEvent({ capacity, price = 15000 }) {
    const [event] = await ctx.db('events')
      .insert({
        club_id: club.club.id,
        title: 'Concurrency Night',
        venue: 'Hall',
        starts_at: '2026-12-01T12:30:00Z',
        ends_at: '2026-12-01T15:30:00Z',
        registration_opens_at: '2026-10-01T00:00:00Z',
        registration_closes_at: '2026-11-30T00:00:00Z',
        capacity,
        member_price_paise: price,
        non_member_price_paise: price,
        status: 'PUBLISHED',
        created_by: club.head.id,
        published_at: '2026-10-01T00:00:00Z',
      })
      .returning('*');
    await ctx.db('event_organizers').insert({ event_id: event.id, user_id: club.head.id, assigned_by: club.head.id });
    return event;
  }

  const book = (agent, eventId, price = 15000) =>
    agent.post(`/api/v1/events/${eventId}/bookings`).set(H).set('Idempotency-Key', idemKey()).send({ expectedFinalPricePaise: price });

  it('TC-EVT-01: capacity 10, 50 parallel bookings → exactly 10 reserved, 40 SOLD_OUT', async () => {
    const event = await publishedEvent({ capacity: 10 });
    const agents = await Promise.all(Array.from({ length: 50 }, async () => ctx.signIn((await makeUser(ctx.db)).id)));
    const res = await Promise.all(agents.map((a) => book(a, event.id)));
    expect(res.filter((r) => r.status === 201)).toHaveLength(10);
    const rejected = res.filter((r) => r.status !== 201);
    expect(rejected).toHaveLength(40);
    expect(rejected.every((r) => r.status === 409 && r.body.error.code === 'SOLD_OUT')).toBe(true);
    expect((await ctx.db('events').where({ id: event.id }).first()).seats_reserved).toBe(10);
    expect(await ctx.db('bookings').where({ event_id: event.id }).whereIn('status', ['PENDING_PAYMENT', 'CONFIRMED'])).toHaveLength(10);
  });

  it('TC-CHK-03: 20 simultaneous scans of one ticket → exactly one check-in', async () => {
    const event = await publishedEvent({ capacity: 5 });
    const buyer = await ctx.signIn((await makeUser(ctx.db)).id);
    const booked = await book(buyer, event.id);
    expect(booked.status).toBe(201);
    await pay(buyer, booked.body.data.payment.id).expect(200);
    const ticket = await ctx.db('tickets').where({ event_id: event.id }).first();
    const scanners = await Promise.all(Array.from({ length: 20 }, () => ctx.signIn(club.head.id)));
    const res = await Promise.all(
      scanners.map((s) => s.post(`/api/v1/events/${event.id}/check-ins`).set(H).set('Idempotency-Key', idemKey()).send({ qrPayload: `SOMS1:T:${ticket.qr_token}` })),
    );
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409 && r.body.error.code === 'TICKET_ALREADY_USED')).toHaveLength(19);
    expect(await ctx.db('check_ins').where({ ticket_id: ticket.id })).toHaveLength(1);
    expect((await ctx.db('tickets').where({ id: ticket.id }).first()).status).toBe('USED');
  });

  async function autopayDueMember() {
    const user = await makeUser(ctx.db);
    await verifyStudent(ctx.db, user.id);
    const [plan] = await ctx.db('membership_plans').insert({ club_id: club.club.id, name: 'Annual', fee_paise: 50000, duration_months: 12, created_by: club.head.id }).returning('*');
    const [m] = await ctx.db('memberships')
      .insert({ user_id: user.id, club_id: club.club.id, status: 'ACTIVE', member_number: 'AP-1', current_plan_id: plan.id, started_on: '2025-11-02', expires_on: '2026-11-01', qr_token: `ap-${crypto.randomUUID()}`, autopay_enabled: true, autopay_plan_id: plan.id, autopay_amount_paise: 50000 })
      .returning('*');
    return m;
  }

  it('TC-AP-02: AutoPay job run twice concurrently (locked runner) → 1 attempt, 1 payment, extended once', async () => {
    const m = await autopayDueMember();
    const results = await Promise.all([ctx.container.jobs.run('autopay-renewals'), ctx.container.jobs.run('autopay-renewals')]);
    expect(results.filter((r) => r.status === 'SUCCEEDED')).toHaveLength(1);
    expect(await ctx.db('renewal_attempts').where({ membership_id: m.id })).toHaveLength(1);
    const payments = await ctx.db('payments').where({ club_id: club.club.id, method: 'SIMULATED_AUTOPAY' });
    expect(payments).toHaveLength(1);
    expect((await ctx.db('memberships').where({ id: m.id }).first()).expires_on).toBe('2027-11-01');
    expect(await ctx.db('financial_transactions').where({ payment_id: payments[0].id })).toHaveLength(1);
  });

  it('TC-AP-02: the job body itself is safe when run twice in parallel without the lock', async () => {
    const m = await autopayDueMember();
    const def = ctx.container.jobs.get('autopay-renewals');
    await Promise.all([def.run({ now: ctx.clock.now() }), def.run({ now: ctx.clock.now() })]);
    expect(await ctx.db('renewal_attempts').where({ membership_id: m.id })).toHaveLength(1);
    expect(await ctx.db('payments').where({ club_id: club.club.id, method: 'SIMULATED_AUTOPAY' })).toHaveLength(1);
  });
});
