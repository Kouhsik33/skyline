import bcrypt from 'bcrypt';
import { G1 } from '../seedData/demoIds.js';

/**
 * Group 1 demo seed (dev only): users, one club with roles, a plan, an ACTIVE member with a PAID
 * term, and a PUBLISHED event with capacity.
 *
 * - Idempotent: fixed ids + INSERT … ON CONFLICT DO NOTHING; a second run inserts nothing.
 * - No real people: names are fictional, emails use the reserved example.test domain, the only
 *   phone number is in the fictional +1-555-0100…0199 range. No student identifiers and no
 *   college_verifications rows (Group 1: "verification is never pre-seeded",
 *   001_demo_college_students.js).
 * - Passwords: bcrypt cost 12. Every demo account uses the password below (dev only).
 */
export const DEMO_PASSWORD = 'SkylineDemo#2026';
const BCRYPT_COST = 12;

export async function seed(knex) {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_COST);
  const { users } = G1;

  await knex.transaction(async (trx) => {
    const put = (table, rows) => trx(table).insert(rows).onConflict().ignore();

    await put('users', [
      { id: users.head, email: 'head@demo.example.test', full_name: 'Asha Demo (Club Head)', password_hash: passwordHash },
      { id: users.treasurer, email: 'treasurer@demo.example.test', full_name: 'Ravi Demo (Treasurer)', password_hash: passwordHash },
      { id: users.volunteer, email: 'volunteer@demo.example.test', full_name: 'Meera Demo (Volunteer)', password_hash: passwordHash, phone_e164: '+15555550123' },
      { id: users.member, email: 'member@demo.example.test', full_name: 'Kiran Demo (Member)', password_hash: passwordHash },
      { id: users.buyer, email: 'buyer@demo.example.test', full_name: 'Dev Demo (Non-member)', password_hash: passwordHash },
      { id: users.organizer, email: 'organizer@demo.example.test', full_name: 'Neha Demo (Organizer)', password_hash: passwordHash },
    ]);

    await put('clubs', {
      id: G1.club,
      slug: 'demo-skyline',
      name: 'Skyline Demo Club',
      description: 'Demo club created by the dev seed.',
      contact_email: 'club@demo.example.test',
      member_number_prefix: 'DEMO',
      next_member_seq: 2, // DEMO-000001 is taken by the seeded member
    });

    await put('club_role_assignments', [
      { id: G1.roles.head, club_id: G1.club, user_id: users.head, role: 'CLUB_HEAD' },
      { id: G1.roles.treasurer, club_id: G1.club, user_id: users.treasurer, role: 'TREASURER', assigned_by: users.head },
      { id: G1.roles.volunteer, club_id: G1.club, user_id: users.volunteer, role: 'VOLUNTEER', assigned_by: users.head },
    ]);

    await put('membership_plans', {
      id: G1.plan,
      club_id: G1.club,
      name: 'Annual',
      description: 'Twelve-month membership',
      benefits_text: '10% off events and merchandise; early-bird access',
      fee_paise: 50000,
      duration_months: 12,
      event_discount_bps: 1000,
      merch_discount_bps: 1000,
      early_bird_access: true,
      status: 'ACTIVE',
      created_by: users.head,
    });

    await put('memberships', {
      id: G1.membership,
      user_id: users.member,
      club_id: G1.club,
      status: 'ACTIVE',
      member_number: 'DEMO-000001',
      current_plan_id: G1.plan,
      started_on: '2026-07-01',
      expires_on: '2027-06-30',
      qr_token: 'seedDemoMembershipQrTok1',
    });

    await put('membership_terms', {
      id: G1.term,
      membership_id: G1.membership,
      club_id: G1.club,
      user_id: users.member,
      kind: 'JOIN',
      source: 'MANUAL',
      plan_id: G1.plan,
      plan_name: 'Annual',
      fee_paise: 50000,
      duration_months: 12,
      event_discount_bps: 1000,
      merch_discount_bps: 1000,
      early_bird_access: true,
      benefits_text: '10% off events and merchandise; early-bird access',
      status: 'PAID',
      starts_on: '2026-07-01',
      ends_on: '2027-06-30',
      paid_at: '2026-07-01T04:30:00Z',
    });

    await put('events', {
      id: G1.event,
      club_id: G1.club,
      title: 'Skyline Demo Night',
      description: 'Demo event created by the dev seed.',
      venue: 'Main Auditorium',
      starts_at: '2026-11-20T12:30:00Z', // 18:00 IST
      ends_at: '2026-11-20T15:30:00Z',
      registration_opens_at: '2026-10-01T03:30:00Z',
      registration_closes_at: '2026-11-19T18:29:00Z',
      capacity: 100,
      seats_reserved: 0,
      member_price_paise: 15000,
      non_member_price_paise: 25000,
      member_discount_eligible: true,
      status: 'PUBLISHED',
      created_by: users.head,
      published_at: '2026-10-01T03:30:00Z',
    });

    await put('event_organizers', { event_id: G1.event, user_id: users.organizer, assigned_by: users.head });
    await put('event_staff', { event_id: G1.event, user_id: users.volunteer, club_id: G1.club, assigned_by: users.head });
  });
}
