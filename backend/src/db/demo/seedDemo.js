/**
 * Demo data for local development: the same story the frontend's in-browser demo backend
 * (frontend/src/api/mock/seed.js) tells, written straight into PostgreSQL so every role can be
 * tried against the real API without registering or passing college verification.
 *
 * DEV ONLY. Every demo account shares the password DEMO_PASSWORD and is created already
 * VERIFIED, which the real register flow never allows. Run it with `npm run seed:demo`
 * (scripts/seed-demo.js); it is deliberately not part of `npm run seed` or server start-up.
 *
 * Money is written the way the services write it: each SUCCEEDED payment has one ledger row,
 * each PAID expense one ledger OUT row, stock counters follow the stock-movement rules. The
 * seed re-checks that with the app's own reconciliation rules (LLD §2.10) before committing.
 *
 * Dates are relative to the day the seed runs (IST), like the frontend demo.
 */
import bcrypt from 'bcrypt';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config/index.js';
import { computeTermEndsOn, todayIST } from '../../shared/clock.js';
import { addDays, startOfDay } from '../../shared/dates.js';
import { applyBps } from '../../shared/money.js';
import { pickupCode, randomReference, randomToken, ticketCode } from '../../shared/tokens.js';

export const DEMO_PASSWORD = 'demo1234';

/** The accounts the frontend's sign-in page lists, plus the two extra personas. */
export const DEMO_ACCOUNTS = Object.freeze([
  { email: 'asha@srkrec.ac.in', name: 'Asha Rao', roles: 'Club head of Skyline; volunteer in Robotics' },
  { email: 'ravi@srkrec.ac.in', name: 'Ravi Kumar', roles: 'Treasurer of Skyline' },
  { email: 'meera@srkrec.ac.in', name: 'Meera Iyer', roles: 'Volunteer and event staff in Skyline' },
  { email: 'karthik@srkrec.ac.in', name: 'Karthik Reddy', roles: 'Club head of Photography; treasurer in Robotics; event organizer' },
  { email: 'vikram@srkrec.ac.in', name: 'Vikram Shetty', roles: 'Club head of Robotics' },
  { email: 'priya.nair@gmail.com', name: 'Priya Nair', roles: 'Plain user: no club roles, not college-verified' },
]);

const FIRST = ['Aarav', 'Diya', 'Vihaan', 'Ananya', 'Ishaan', 'Saanvi', 'Arjun', 'Kavya', 'Rohan', 'Nisha', 'Aditya', 'Pooja', 'Siddharth', 'Lakshmi', 'Varun', 'Sneha', 'Rahul', 'Divya', 'Nikhil', 'Harini', 'Tarun', 'Bhavya', 'Kiran', 'Swathi', 'Manoj', 'Keerthi', 'Pranav', 'Yamini', 'Gautham', 'Ritika', 'Sai', 'Teja', 'Akhil', 'Sravya', 'Naveen', 'Mounika'];
const LAST = ['Sharma', 'Reddy', 'Iyer', 'Varma', 'Naidu', 'Menon', 'Rao', 'Pillai', 'Gupta', 'Das', 'Chowdary', 'Krishnan'];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CHUNK = 400;

/** Tables owned by the app, in the order they can be inserted without breaking a foreign key. */
const INSERT_ORDER = [
  'users', 'college_verifications', 'clubs', 'club_role_assignments', 'membership_plans', 'memberships', 'membership_terms',
  'autopay_consents', 'events', 'event_organizers', 'event_staff', 'bookings', 'tickets', 'check_ins', 'product_categories',
  'products', 'product_variants', 'orders', 'order_items', 'payments', 'stock_movements', 'low_stock_alerts', 'announcements',
  'notification_deliveries', 'fundraisers', 'fundraiser_tasks', 'budgets', 'uploaded_files', 'expenses', 'financial_transactions',
];

export async function assertSomsDatabase(knex) {
  const has = await knex.schema.hasTable('knex_migrations');
  const migrated = has ? await knex('knex_migrations').where({ name: '013_budgets_expenses_ledger.js' }).first() : null;
  if (!migrated) {
    throw new Error('This database has no Campus Flow schema. Run `npm run migrate` first.');
  }
}

export async function demoDataPresent(knex) {
  const row = await knex('users').whereRaw('lower(email) = ?', [DEMO_ACCOUNTS[0].email]).first('id');
  return Boolean(row);
}

export async function countRows(knex, tables = ['users', 'clubs', 'events', 'payments']) {
  const out = {};
  for (const t of tables) out[t] = Number((await knex(t).count('* as n').first()).n);
  return out;
}

/** Removes every row from every app table. Only reached when the caller passed --reset. */
async function wipeAppData(knex) {
  const { rows } = await knex.raw(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name NOT IN ('knex_migrations', 'knex_migrations_lock')`,
  );
  const names = rows.map((r) => `"${r.table_name}"`).join(', ');
  if (names) await knex.raw(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

/** A small, valid one-page PDF so the receipt links open something real. */
function receiptPdf(lines) {
  const esc = (s) => s.replace(/[\\()]/g, '\\$&').replace(/[^\x20-\x7e]/g, '?');
  const content = `BT /F1 14 Tf 72 760 Td 20 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/**
 * Builds every row in memory (no database access), so the relationships can be checked and the
 * insert is one pass. `passwordHash` is bcrypt(DEMO_PASSWORD).
 */
export function buildDemoData({ passwordHash, verificationKey, now = new Date() }) {
  const tz = config.APP_TIMEZONE;
  const today = todayIST();
  const istDate = (offsetDays) => addDays(today, offsetDays);
  const at = (offsetDays, hour = 10) => new Date(startOfDay(istDate(offsetDays), tz).getTime() + hour * HOUR);
  const past = (d) => (d > now ? now : d);
  const plus = (d, ms) => new Date(d.getTime() + ms);
  const id = () => randomUUID();
  const hmac = (v) => createHmac('sha256', verificationKey).update(v).digest('hex');

  const t = Object.fromEntries(INSERT_ORDER.map((name) => [name, []]));
  const receipts = []; // { storageKey, buffer }

  /* ── Users ─────────────────────────────────────────────────────────── */
  const phoneFor = (n) => `+9198${String(10000000 + ((n * 7654321) % 89999999)).padStart(8, '0')}`;
  const mkUser = (fullName, email, { phone, verified = true, studentId } = {}) => {
    const u = { id: id(), email, full_name: fullName, phone_e164: phone === undefined ? phoneFor(t.users.length + 1) : phone, password_hash: passwordHash, is_active: true, created_at: at(-300), updated_at: at(-300) };
    t.users.push(u);
    if (verified) {
      const sid = studentId || `SRKR2023${String(t.users.length).padStart(4, '0')}`;
      t.college_verifications.push({ id: id(), user_id: u.id, outcome: 'VERIFIED', student_identifier_hash: hmac(sid), adapter: 'mock', external_reference: null, checked_at: at(-280), superseded_at: null, created_at: at(-280) });
    }
    return u;
  };
  const asha = mkUser('Asha Rao', 'asha@srkrec.ac.in', { studentId: 'SRKR2023CS001' });
  const ravi = mkUser('Ravi Kumar', 'ravi@srkrec.ac.in');
  const meera = mkUser('Meera Iyer', 'meera@srkrec.ac.in');
  const karthik = mkUser('Karthik Reddy', 'karthik@srkrec.ac.in');
  const priya = mkUser('Priya Nair', 'priya.nair@gmail.com', { verified: false, phone: null });
  const vikram = mkUser('Vikram Shetty', 'vikram@srkrec.ac.in');
  const others = [];
  for (let i = 0; i < 36; i += 1) {
    const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`;
    others.push(mkUser(name, `${name.toLowerCase().replace(' ', '.')}${i}@srkrec.ac.in`, { phone: i % 9 === 0 ? null : undefined }));
  }
  const userById = new Map(t.users.map((u) => [u.id, u]));

  /* ── Clubs and roles ───────────────────────────────────────────────── */
  const mkClub = (name, slug, prefix, description, head) => {
    const c = { id: id(), slug, name, description, contact_email: `${slug}@srkrec.ac.in`, is_active: true, member_number_prefix: prefix, next_member_seq: 1, created_at: at(-330), updated_at: at(-330), head };
    t.clubs.push(c);
    return c;
  };
  const sky = mkClub('Skyline Student Association', 'skyline', 'SKY', 'The college-wide student association: fests, workshops, welfare drives and the semester merch drop.', asha);
  const robo = mkClub('Robotics Club', 'robotics', 'ROB', 'Build nights, line-follower races and the inter-college robotics league.', vikram);
  const photo = mkClub('Photography Society', 'photography', 'PHO', 'Photo walks, editing workshops and the annual campus exhibition.', karthik);
  const allocateMemberNumber = (club) => {
    const n = club.next_member_seq;
    club.next_member_seq += 1;
    return `${club.member_number_prefix}-${String(n).padStart(6, '0')}`;
  };

  const role = (club, user, r, by = asha) => t.club_role_assignments.push({ id: id(), club_id: club.id, user_id: user.id, role: r, assigned_by: by.id, assigned_at: at(-200), revoked_at: null, revoked_by: null });
  role(sky, asha, 'CLUB_HEAD');
  role(sky, ravi, 'TREASURER');
  role(sky, meera, 'VOLUNTEER');
  role(sky, others[0], 'VOLUNTEER');
  role(sky, others[1], 'VOLUNTEER');
  role(sky, others[2], 'VOLUNTEER');
  role(robo, vikram, 'CLUB_HEAD', vikram);
  role(robo, asha, 'VOLUNTEER', vikram);
  role(robo, karthik, 'TREASURER', vikram);
  role(photo, karthik, 'CLUB_HEAD', karthik);

  /* ── Payments and the ledger (shared by memberships, tickets and orders) ── */
  const mkPayment = ({ club, user, purpose, target, amountPaise, when, outcome }) => {
    const settledAt = outcome ? past(plus(when, 45_000)) : null;
    const p = {
      id: id(), club_id: club.id, user_id: user.id, purpose, membership_term_id: null, booking_id: null, order_id: null, ...target,
      amount_paise: amountPaise, currency: 'INR', method: 'SIMULATED', is_simulated: true, status: outcome ?? 'INITIATED',
      reference: randomReference('SIM'), failure_reason: outcome === 'FAILED' ? 'FAILED' : null, created_at: when, updated_at: settledAt ?? when, settled_at: settledAt,
    };
    t.payments.push(p);
    return p;
  };
  const postLedger = (e) => {
    const at_ = e.occurredAt;
    t.financial_transactions.push({
      id: id(), club_id: e.clubId, direction: e.direction, category: e.category, amount_paise: e.amountPaise, currency: 'INR', status: 'POSTED',
      source_type: e.sourceType, source_id: e.sourceId, payment_id: e.paymentId ?? null, expense_id: e.expenseId ?? null, event_id: e.eventId ?? null,
      fundraiser_id: e.fundraiserId ?? null, membership_id: e.membershipId ?? null, order_id: e.orderId ?? null, payer_user_id: e.payerUserId ?? null,
      recorded_by: e.recordedBy ?? null, approved_by: e.approvedBy ?? null, description: e.description, reference: e.reference ?? null,
      evidence_file_id: e.evidenceFileId ?? null, occurred_at: at_, created_at: at_,
    });
  };
  const postPaymentIncome = (payment, category, extra, description) =>
    postLedger({
      clubId: payment.club_id, direction: 'IN', category, amountPaise: payment.amount_paise, sourceType: 'PAYMENT', sourceId: payment.id, paymentId: payment.id,
      payerUserId: payment.user_id, description: description ?? `${category} payment ${payment.reference}`, reference: payment.reference, occurredAt: payment.settled_at, ...extra,
    });

  /* ── Membership plans, joins, AutoPay ──────────────────────────────── */
  const mkPlan = (club, p) => {
    const plan = { id: id(), club_id: club.id, status: 'ACTIVE', created_by: club.head.id, created_at: at(-320), updated_at: at(-320), ...p };
    t.membership_plans.push(plan);
    return plan;
  };
  const skySem = mkPlan(sky, { name: 'Semester', description: 'Six months of membership for one semester.', benefits_text: '10% off event tickets\n5% off merchandise', fee_paise: 30000, duration_months: 6, event_discount_bps: 1000, merch_discount_bps: 500, early_bird_access: false });
  const skyAnnual = mkPlan(sky, { name: 'Annual', description: 'Full academic year with early access to popular events.', benefits_text: '15% off event tickets\n10% off merchandise\nEarly access to registrations', fee_paise: 50000, duration_months: 12, event_discount_bps: 1500, merch_discount_bps: 1000, early_bird_access: true });
  mkPlan(sky, { name: 'Founders 2025', description: 'Launch offer for the first batch.', benefits_text: '20% off everything', fee_paise: 25000, duration_months: 12, event_discount_bps: 2000, merch_discount_bps: 2000, early_bird_access: true, status: 'ARCHIVED' });
  const roboStd = mkPlan(robo, { name: 'Builder', description: 'Lab access and league registration.', benefits_text: 'Free build nights\n10% off kits', fee_paise: 40000, duration_months: 12, event_discount_bps: 1000, merch_discount_bps: 1000, early_bird_access: true });
  mkPlan(photo, { name: 'Shutterbug', description: 'Walks, workshops and exhibition entry.', benefits_text: 'Free photo walks\n10% off prints', fee_paise: 20000, duration_months: 6, event_discount_bps: 1000, merch_discount_bps: 1000, early_bird_access: false });

  const membershipOf = new Map(); // `${userId}:${clubId}` -> membership
  const termOf = new Map(); // membership id -> its PAID term
  const join = (user, club, plan, daysAgo, outcome = 'SUCCEEDED') => {
    const when = past(at(-daysAgo, 11));
    const startsOn = istDate(-daysAgo);
    const membership = { id: id(), user_id: user.id, club_id: club.id, status: 'PENDING_PAYMENT', member_number: null, current_plan_id: null, started_on: null, expires_on: null, qr_token: randomToken(16), autopay_enabled: false, autopay_plan_id: null, autopay_amount_paise: null, created_at: when, updated_at: when };
    const term = {
      id: id(), membership_id: membership.id, club_id: club.id, user_id: user.id, kind: 'JOIN', source: 'MANUAL', plan_id: plan.id, plan_name: plan.name, fee_paise: plan.fee_paise,
      duration_months: plan.duration_months, event_discount_bps: plan.event_discount_bps, merch_discount_bps: plan.merch_discount_bps, early_bird_access: plan.early_bird_access,
      benefits_text: plan.benefits_text, status: 'PENDING_PAYMENT', starts_on: null, ends_on: null, paid_at: null, created_at: when,
    };
    const payment = mkPayment({ club, user, purpose: 'MEMBERSHIP_JOIN', target: { membership_term_id: term.id }, amountPaise: plan.fee_paise, when, outcome });
    if (outcome === 'SUCCEEDED') {
      term.status = 'PAID';
      term.starts_on = startsOn;
      term.ends_on = computeTermEndsOn(startsOn, plan.duration_months);
      term.paid_at = payment.settled_at;
      // Past-dated terms that already ended are stored as the membership-expiry job would leave them.
      membership.status = term.ends_on >= today ? 'ACTIVE' : 'EXPIRED';
      membership.member_number = allocateMemberNumber(club);
      membership.current_plan_id = plan.id;
      membership.started_on = startsOn;
      membership.expires_on = term.ends_on;
      termOf.set(membership.id, term);
      postPaymentIncome(payment, 'MEMBERSHIP_DUES', { membershipId: membership.id });
    } else if (outcome === 'FAILED') {
      term.status = 'FAILED';
      membership.status = 'CANCELLED';
    }
    t.memberships.push(membership);
    t.membership_terms.push(term);
    membershipOf.set(`${user.id}:${club.id}`, membership);
    return membership;
  };

  join(asha, sky, skyAnnual, 120);
  join(ravi, sky, skyAnnual, 118);
  join(meera, sky, skySem, 100);
  join(karthik, sky, skyAnnual, 90);
  join(vikram, robo, roboStd, 150);
  join(asha, robo, roboStd, 140);
  others.forEach((u, i) => {
    if (i % 6 === 5) return; // some students are not members
    const annual = i % 3 === 0;
    let daysAgo = 10 + ((i * 13) % 160);
    if (i === 7 || i === 13) daysAgo = 177; // semester members expiring within a week
    if (i === 19 || i === 25) daysAgo = 200; // lapsed
    join(u, sky, annual && ![7, 13, 19, 25].includes(i) ? skyAnnual : skySem, daysAgo);
    if (i % 4 === 0) join(u, robo, roboStd, 30 + i);
  });
  join(others[5], sky, skySem, 3, 'FAILED'); // a failed attempt
  join(others[11], sky, skyAnnual, 0, null); // a join waiting for payment

  const ashaSky = membershipOf.get(`${asha.id}:${sky.id}`);
  ashaSky.autopay_enabled = true;
  ashaSky.autopay_plan_id = skyAnnual.id;
  ashaSky.autopay_amount_paise = skyAnnual.fee_paise;
  t.autopay_consents.push({ id: id(), membership_id: ashaSky.id, user_id: asha.id, action: 'ENABLED', plan_id: skyAnnual.id, consented_amount_paise: skyAnnual.fee_paise, consent_text_version: 'v1', created_at: at(-60) });

  /** Benefits from the user's PAID term that covers today, as the real getActiveBenefits returns them. */
  const benefitsOf = (userId, clubId) => {
    const m = membershipOf.get(`${userId}:${clubId}`);
    const term = m && m.status === 'ACTIVE' ? termOf.get(m.id) : null;
    if (!term || term.starts_on > today || term.ends_on < today) return null;
    return { termId: term.id, eventDiscountBps: term.event_discount_bps, merchDiscountBps: term.merch_discount_bps };
  };

  /* ── Events, bookings, tickets, check-ins ──────────────────────────── */
  const mkEvent = (club, e) => {
    const ev = {
      id: id(), club_id: club.id, title: '', description: '', venue: '', capacity: 0, seats_reserved: 0, member_price_paise: 0, non_member_price_paise: null,
      member_discount_eligible: true, early_access_opens_at: null, early_bird_member_price_paise: null, early_bird_non_member_price_paise: null, early_bird_ends_at: null,
      early_bird_quantity: null, early_bird_reserved: 0, status: 'PUBLISHED', cancel_reason: null, created_by: club.head.id, published_at: at(-60), cancelled_at: null,
      completed_at: null, created_at: at(-60), updated_at: at(-60), ...e,
    };
    if (ev.status === 'DRAFT') ev.published_at = null;
    t.events.push(ev);
    return ev;
  };
  const techFest = mkEvent(sky, {
    title: 'Skyline Tech Fest 2026', description: 'Two days of talks, project expo and the inter-department coding sprint. Lunch included both days.', venue: 'Main Auditorium & CSE Block',
    capacity: 300, member_price_paise: 20000, non_member_price_paise: 35000, early_bird_member_price_paise: 15000, early_bird_non_member_price_paise: 28000, early_bird_quantity: 80,
    early_bird_ends_at: at(6), early_access_opens_at: at(-30), registration_opens_at: at(-25), registration_closes_at: at(19), starts_at: at(20, 9), ends_at: at(21, 18),
  });
  const freshers = mkEvent(sky, {
    title: "Freshers' Welcome Night", description: 'Music, games and introductions for the incoming batch.', venue: 'Open Air Theatre', capacity: 220, member_price_paise: 10000, non_member_price_paise: 15000,
    registration_opens_at: at(-60), registration_closes_at: at(-31), starts_at: at(-30, 18), ends_at: at(-30, 22), created_at: at(-70), published_at: at(-65),
  });
  const hack = mkEvent(sky, {
    title: '24h Campus Hackathon', description: 'Members-only overnight hackathon. Teams of up to four; mentors from alumni startups.', venue: 'Innovation Lab', capacity: 60, member_price_paise: 0, non_member_price_paise: null,
    registration_opens_at: at(-5), registration_closes_at: at(9), starts_at: at(10, 9), ends_at: at(11, 9),
  });
  mkEvent(sky, {
    title: 'Startup Pitch Workshop', description: 'Learn to write a 3-minute pitch with feedback from the incubation cell.', venue: 'Seminar Hall 2', status: 'DRAFT', capacity: 80, member_price_paise: 5000, non_member_price_paise: 10000,
    registration_opens_at: at(5), registration_closes_at: at(29), starts_at: at(30, 14), ends_at: at(30, 17),
  });
  mkEvent(sky, {
    title: 'Monsoon Film Screening', description: 'Cancelled due to auditorium maintenance.', venue: 'Main Auditorium', status: 'CANCELLED', cancel_reason: 'Venue unavailable', cancelled_at: at(-3), capacity: 150,
    member_price_paise: 3000, non_member_price_paise: 5000, registration_opens_at: at(-20), registration_closes_at: at(-2), starts_at: at(-1, 18), ends_at: at(-1, 21),
  });
  const roboRace = mkEvent(robo, {
    title: 'Line Follower Race', description: 'Bring your bot. Three heats, fastest clean lap wins.', venue: 'Mech Workshop', capacity: 40, member_price_paise: 5000, non_member_price_paise: 12000,
    registration_opens_at: at(-10), registration_closes_at: at(13), starts_at: at(14, 10), ends_at: at(14, 16),
  });
  mkEvent(photo, {
    title: 'Golden Hour Photo Walk', description: 'Walk around the lake campus at sunset.', venue: 'Main Gate', capacity: 30, member_price_paise: 0, non_member_price_paise: 5000,
    registration_opens_at: at(-3), registration_closes_at: at(6), starts_at: at(7, 17), ends_at: at(7, 19),
  });

  const clubById = new Map(t.clubs.map((c) => [c.id, c]));
  const organize = (ev, user) => t.event_organizers.push({ event_id: ev.id, user_id: user.id, assigned_by: clubById.get(ev.club_id).head.id, assigned_at: at(-55) });
  const staff = (ev, user) => t.event_staff.push({ event_id: ev.id, user_id: user.id, club_id: ev.club_id, assigned_by: clubById.get(ev.club_id).head.id, assigned_at: at(-50) });
  organize(techFest, karthik);
  organize(freshers, karthik);
  organize(hack, meera);
  organize(roboRace, vikram);
  staff(techFest, meera);
  staff(techFest, others[0]);
  staff(freshers, meera);
  staff(hack, others[1]);

  const quoteTicket = (ev, user, useEarlyBird) => {
    const b = benefitsOf(user.id, ev.club_id);
    const isMember = Boolean(b);
    if (!isMember && ev.non_member_price_paise == null) return null; // members-only event
    const base = isMember ? ev.member_price_paise : ev.non_member_price_paise;
    const memberDiscount = isMember && ev.member_discount_eligible ? applyBps(base, b.eventDiscountBps) : 0;
    let quote = { tier: isMember ? 'MEMBER_REGULAR' : 'NON_MEMBER_REGULAR', list: base, disc: memberDiscount, final: base - memberDiscount, usesEarlyBird: false };
    const ebPrice = isMember ? ev.early_bird_member_price_paise : ev.early_bird_non_member_price_paise;
    if (useEarlyBird && ebPrice != null && ev.early_bird_reserved < (ev.early_bird_quantity ?? 0) && ebPrice <= quote.final) {
      quote = { tier: isMember ? 'MEMBER_EARLY_BIRD' : 'NON_MEMBER_EARLY_BIRD', list: ebPrice, disc: 0, final: ebPrice, usesEarlyBird: true };
    }
    if (quote.final === 0) quote.tier = 'FREE';
    return { ...quote, isMember, termId: b?.termId ?? null };
  };

  const ticketsOf = new Map(); // event id -> [ticket] in booking order
  const book = (ev, user, daysAgo, { useEarlyBird = false, outcome = 'SUCCEEDED' } = {}) => {
    const q = quoteTicket(ev, user, useEarlyBird);
    if (!q) return null;
    const when = past(at(-daysAgo, 9 + (daysAgo % 9)));
    const free = q.final === 0;
    const booking = {
      id: id(), event_id: ev.id, club_id: ev.club_id, user_id: user.id, status: 'PENDING_PAYMENT', buyer_type: q.isMember ? 'MEMBER' : 'NON_MEMBER', price_tier: q.tier,
      list_price_paise: q.list, discount_paise: q.disc, final_price_paise: q.final, pricing_mode: 'BEST_OF', membership_term_id: q.termId, uses_early_bird: q.usesEarlyBird,
      hold_expires_at: null, confirmed_at: null, cancelled_at: null, cancel_reason: null, created_at: when,
    };
    let payment = null;
    if (free) {
      booking.status = 'CONFIRMED';
      booking.confirmed_at = when;
    } else {
      payment = mkPayment({ club: clubById.get(ev.club_id), user, purpose: 'EVENT_TICKET', target: { booking_id: booking.id }, amountPaise: q.final, when, outcome });
      if (outcome === 'SUCCEEDED') {
        booking.status = 'CONFIRMED';
        booking.confirmed_at = payment.settled_at;
        postPaymentIncome(payment, 'TICKET_SALE', { eventId: ev.id }, `Ticket sale ${payment.reference}`);
      } else if (outcome === 'FAILED') {
        booking.status = 'CANCELLED';
        booking.cancelled_at = payment.settled_at;
        booking.cancel_reason = 'FAILED';
      } else {
        booking.hold_expires_at = plus(now, DAY); // a hold that outlives the usual 15 minutes so it can be demoed
      }
    }
    if (booking.status !== 'CANCELLED') {
      ev.seats_reserved += 1;
      if (q.usesEarlyBird) ev.early_bird_reserved += 1;
      if (ev.seats_reserved > ev.capacity) throw new Error(`demo seed oversold "${ev.title}"`);
    }
    t.bookings.push(booking);
    if (booking.status === 'CONFIRMED') {
      const ticket = { id: id(), booking_id: booking.id, event_id: ev.id, club_id: ev.club_id, user_id: user.id, ticket_code: ticketCode(), qr_token: randomToken(16), status: 'VALID', issued_at: booking.confirmed_at, used_at: null, used_by: null, cancelled_at: null };
      t.tickets.push(ticket);
      if (!ticketsOf.has(ev.id)) ticketsOf.set(ev.id, []);
      ticketsOf.get(ev.id).push(ticket);
    }
    return booking;
  };

  const audience = [asha, ravi, meera, karthik, priya, vikram, ...others];
  audience.slice(0, 32).forEach((u, i) => book(freshers, u, 40 + (i % 18)));
  audience.slice(1, 40).forEach((u, i) => book(techFest, u, 1 + ((i * 5) % 24), { useEarlyBird: i < 22, outcome: i === 3 ? 'FAILED' : 'SUCCEEDED' }));
  book(techFest, others[34], 0, { outcome: null }); // a held seat awaiting payment
  audience.slice(2, 16).forEach((u, i) => book(hack, u, 1 + (i % 4)));
  [vikram, asha, karthik, ...others.slice(0, 9)].forEach((u, i) => book(roboRace, u, 1 + (i % 8)));
  if (!t.bookings.some((b) => b.user_id === asha.id && b.event_id === techFest.id)) book(techFest, asha, 2, { useEarlyBird: true });

  freshers.status = 'COMPLETED';
  freshers.completed_at = freshers.ends_at;
  (ticketsOf.get(freshers.id) ?? []).forEach((ticket, i) => {
    if (i % 7 === 6) return; // no-shows
    const usedAt = new Date(freshers.starts_at.getTime() + (i % 10) * 9 * 60_000);
    ticket.status = 'USED';
    ticket.used_at = usedAt;
    ticket.used_by = meera.id;
    t.check_ins.push({ id: id(), ticket_id: ticket.id, event_id: freshers.id, checked_in_by: meera.id, checked_in_at: usedAt });
  });

  /* ── Merchandise ───────────────────────────────────────────────────── */
  const mkCategory = (club, name) => {
    const c = { id: id(), club_id: club.id, name };
    t.product_categories.push(c);
    return c;
  };
  const apparel = mkCategory(sky, 'Apparel');
  const accessories = mkCategory(sky, 'Accessories');
  const roboKits = mkCategory(robo, 'Kits');
  const movement = (variant, type, quantity, createdAt, extra = {}) =>
    t.stock_movements.push({ id: id(), variant_id: variant.id, club_id: variant.club_id, type, quantity, reason: null, order_id: null, actor_user_id: null, created_at: createdAt, ...extra });

  const mkProduct = (club, category, p, sizes) => {
    const product = {
      id: id(), club_id: club.id, category_id: category.id, description: '', member_discount_eligible: true, available_to_non_members: true, offer_price_paise: null, offer_starts_at: null,
      offer_ends_at: null, status: 'ACTIVE', created_by: club.head.id, created_at: at(-90), updated_at: at(-90), ...p,
    };
    t.products.push(product);
    sizes.forEach(([sizeLabel, stock, threshold = 5]) => {
      const variant = { id: id(), product_id: product.id, club_id: club.id, size_label: sizeLabel, stock_on_hand: stock, stock_reserved: 0, low_stock_threshold: threshold, is_active: true, created_at: at(-90), updated_at: at(-90) };
      t.product_variants.push(variant);
      movement(variant, 'RESTOCK', stock, at(-90), { reason: 'Initial stock', actor_user_id: club.head.id });
    });
    return product;
  };
  const hoodie = mkProduct(sky, apparel, { name: 'Skyline Hoodie', description: 'Heavyweight navy hoodie with embroidered logo.', price_paise: 89900, offer_price_paise: 79900, offer_starts_at: at(-3), offer_ends_at: at(4) }, [['S', 14], ['M', 24], ['L', 22], ['XL', 5]]);
  const tee = mkProduct(sky, apparel, { name: 'Tech Fest 2026 T-shirt', description: 'Limited edition fest tee, 100% cotton.', price_paise: 39900 }, [['S', 20], ['M', 30], ['L', 28], ['XL', 12], ['XXL', 6, 3]]);
  const cap = mkProduct(sky, accessories, { name: 'Embroidered Cap', description: 'Adjustable strap, one size.', price_paise: 29900 }, [['ONE_SIZE', 18]]);
  const stickers = mkProduct(sky, accessories, { name: 'Sticker Pack', description: 'Ten die-cut vinyl stickers.', price_paise: 9900, member_discount_eligible: false }, [['ONE_SIZE', 60, 10]]);
  mkProduct(sky, accessories, { name: 'Members-only Tote', description: 'Canvas tote for members.', price_paise: 24900, available_to_non_members: false }, [['ONE_SIZE', 25]]);
  mkProduct(sky, apparel, { name: 'Varsity Jacket', description: 'Pre-order sample, not yet on sale.', price_paise: 189900, status: 'DRAFT' }, [['M', 12, 2], ['L', 12, 2]]);
  mkProduct(robo, roboKits, { name: 'Line Follower Starter Kit', description: 'Chassis, motors, sensor array and driver board.', price_paise: 149900 }, [['ONE_SIZE', 12, 3]]);

  /** Same rules as the real merch quote: an offer replaces the list price while it runs, then member discount. */
  const quoteMerch = (product, benefits, when) => {
    let list = product.price_paise;
    let rule = 'LIST';
    if (product.offer_price_paise != null && when >= product.offer_starts_at && when <= product.offer_ends_at) {
      list = product.offer_price_paise;
      rule = 'OFFER';
    }
    let disc = 0;
    if (benefits && product.member_discount_eligible) {
      disc = applyBps(list, benefits.merchDiscountBps);
      if (disc > 0) rule = 'MEMBER_DISCOUNT';
    }
    return { list, disc, final: Math.max(0, list - disc), rule };
  };
  const usedPickupCodes = new Set();
  const uniquePickupCode = () => {
    let code = pickupCode();
    while (usedPickupCodes.has(code)) code = pickupCode();
    usedPickupCodes.add(code);
    return code;
  };
  const order = (user, picks, daysAgo, outcome = 'SUCCEEDED', pickedUp = false) => {
    const club = clubById.get(picks[0][0].club_id);
    const when = past(at(-daysAgo, 13));
    const benefits = benefitsOf(user.id, club.id);
    const lines = picks.map(([product, size, quantity]) => {
      const variant = t.product_variants.find((v) => v.product_id === product.id && v.size_label === size);
      if (!variant) throw new Error(`demo seed: no ${size} variant for ${product.name}`);
      if (variant.stock_on_hand - variant.stock_reserved < quantity) throw new Error(`demo seed: ${product.name} ${size} is out of stock`);
      return { product, variant, quantity, unit: quoteMerch(product, benefits, when) };
    });
    const subtotal = lines.reduce((s, l) => s + l.unit.list * l.quantity, 0);
    const discount = lines.reduce((s, l) => s + l.unit.disc * l.quantity, 0);
    const o = {
      id: id(), club_id: club.id, user_id: user.id, status: 'PENDING_PAYMENT', buyer_type: benefits ? 'MEMBER' : 'NON_MEMBER', subtotal_paise: subtotal, discount_paise: discount,
      total_paise: subtotal - discount, pricing_mode: 'BEST_OF', membership_term_id: benefits?.termId ?? null, pickup_code: null, hold_expires_at: outcome === null ? plus(now, DAY) : plus(when, 15 * 60_000),
      confirmed_at: null, picked_up_at: null, picked_up_by: null, cancelled_at: null, cancel_reason: null, created_at: when,
    };
    t.orders.push(o);
    lines.forEach((l) => {
      t.order_items.push({
        id: id(), order_id: o.id, club_id: club.id, product_id: l.product.id, variant_id: l.variant.id, quantity: l.quantity, unit_list_price_paise: l.unit.list, unit_discount_paise: l.unit.disc,
        unit_final_price_paise: l.unit.final, line_total_paise: l.unit.final * l.quantity, price_rule: l.unit.rule,
      });
      l.variant.stock_reserved += l.quantity;
      movement(l.variant, 'RESERVE', l.quantity, when, { order_id: o.id, actor_user_id: user.id });
    });
    const payment = mkPayment({ club, user, purpose: 'MERCH_ORDER', target: { order_id: o.id }, amountPaise: o.total_paise, when, outcome });
    if (outcome === 'SUCCEEDED') {
      o.status = 'CONFIRMED';
      o.pickup_code = uniquePickupCode();
      o.confirmed_at = payment.settled_at;
      lines.forEach((l) => {
        l.variant.stock_reserved -= l.quantity;
        l.variant.stock_on_hand -= l.quantity;
        movement(l.variant, 'SALE', -l.quantity, o.confirmed_at, { order_id: o.id });
      });
      postPaymentIncome(payment, 'MERCH_SALE', { orderId: o.id }, `Merchandise order ${o.pickup_code}`);
      if (pickedUp) {
        o.status = 'PICKED_UP';
        o.picked_up_at = past(plus(o.confirmed_at, 2 * DAY));
        o.picked_up_by = club.head.id;
      }
    } else if (outcome === 'FAILED') {
      o.status = 'CANCELLED';
      o.cancelled_at = payment.settled_at;
      o.cancel_reason = 'FAILED';
      lines.forEach((l) => {
        l.variant.stock_reserved -= l.quantity;
        movement(l.variant, 'RELEASE', -l.quantity, o.cancelled_at, { order_id: o.id });
      });
    }
    return o;
  };
  order(asha, [[hoodie, 'M', 1], [stickers, 'ONE_SIZE', 1]], 20, 'SUCCEEDED', true);
  order(ravi, [[tee, 'L', 2]], 18, 'SUCCEEDED', true);
  order(meera, [[hoodie, 'S', 1]], 6);
  order(karthik, [[cap, 'ONE_SIZE', 1], [tee, 'M', 1]], 4);
  order(priya, [[tee, 'S', 1]], 3, 'FAILED');
  others.slice(0, 22).forEach((u, i) => {
    const picks = [[[hoodie, ['S', 'M', 'L', 'XL'][i % 4], 1]], [[tee, ['M', 'L', 'XL', 'XXL'][i % 4], 1]], [[cap, 'ONE_SIZE', 1]], [[stickers, 'ONE_SIZE', 2]]][i % 4];
    order(u, picks, 1 + ((i * 3) % 40), i === 9 ? 'FAILED' : 'SUCCEEDED', i % 3 === 0);
  });
  order(others[23], [[hoodie, 'L', 1]], 0, null); // pending payment, stock reserved

  /* ── Announcements and their email deliveries ──────────────────────── */
  const mkAnnouncement = (club, a, daysAgo) => {
    const author = club.head;
    const an = {
      id: id(), club_id: club.id, event_id: null, audience: 'PUBLIC', send_email: true, status: 'PUBLISHED', created_by: author.id, published_by: author.id, published_at: past(at(-daysAgo, 12)),
      created_at: at(-daysAgo - 1), updated_at: at(-daysAgo - 1), ...a,
    };
    if (an.status === 'DRAFT') {
      an.published_at = null;
      an.published_by = null;
    }
    t.announcements.push(an);
    if (an.status === 'PUBLISHED' && an.send_email) {
      const recipients = new Set(t.memberships.filter((m) => m.club_id === club.id && m.status === 'ACTIVE').map((m) => m.user_id));
      if (an.event_id) t.tickets.filter((tk) => tk.event_id === an.event_id && tk.status !== 'CANCELLED').forEach((tk) => recipients.add(tk.user_id));
      recipients.forEach((userId) => {
        const user = userById.get(userId);
        t.notification_deliveries.push({
          id: id(), club_id: club.id, recipient_user_id: userId, channel: 'EMAIL', template: 'ANNOUNCEMENT', announcement_id: an.id, destination: user.email,
          payload: JSON.stringify({ clubName: club.name, title: an.title, body: an.body, category: an.category, ...(an.event_id ? { link: `/events/${an.event_id}` } : {}) }),
          status: 'SENT', attempts: 1, next_attempt_at: an.published_at, last_error: null, provider: 'dev', provider_message_id: `dev-${id()}`, dedupe_key: `announcement:${an.id}:${userId}:EMAIL`,
          created_at: an.published_at, sent_at: plus(an.published_at, 60_000), claimed_at: null,
        });
      });
    }
    return an;
  };
  mkAnnouncement(sky, { title: 'Tech Fest early-bird tickets are live', body: 'Early-bird pricing is available for the first 80 tickets or until the deadline, whichever comes first.\n\nMembers on the Annual plan got early access last week.', category: 'EVENT', event_id: techFest.id }, 24);
  mkAnnouncement(sky, { title: 'General body meeting on Friday, 4 PM', body: 'Agenda: semester calendar, merch drop, and volunteer sign-ups for the winter clothing drive.\nVenue: Seminar Hall 1.', category: 'MEETING', audience: 'MEMBERS' }, 9);
  mkAnnouncement(sky, { title: 'Reimbursement deadline: 20th of this month', body: 'Submit all pending receipts for September events through the Expenses page before the 20th.', category: 'DEADLINE', audience: 'MEMBERS' }, 5);
  mkAnnouncement(sky, { title: 'Hackathon venue moved to Innovation Lab', body: 'The hackathon has moved from the CSE lab to the Innovation Lab (Block C, 2nd floor). Timings are unchanged.', category: 'SCHEDULE_CHANGE', event_id: hack.id }, 2);
  mkAnnouncement(sky, { title: 'Merch pickup desk timings', body: 'Draft. Confirm timings with the office before publishing.', category: 'GENERAL', status: 'DRAFT' }, 0);
  mkAnnouncement(robo, { title: 'Build night every Thursday', body: 'The lab is open 6–10 PM every Thursday for members.', category: 'MEETING' }, 12);
  // A couple of failed deliveries so the delivery report has something to show.
  t.notification_deliveries.filter((d) => d.template === 'ANNOUNCEMENT').slice(3, 5).forEach((d) => {
    d.status = 'FAILED';
    d.attempts = 3;
    d.last_error = 'Mailbox unavailable (simulated)';
    d.sent_at = null;
    d.provider = null;
    d.provider_message_id = null;
  });

  // Open low-stock alerts, and the email each club head would have received.
  t.product_variants.forEach((v) => {
    const available = v.stock_on_hand - v.stock_reserved;
    if (available > v.low_stock_threshold) return;
    const product = t.products.find((p) => p.id === v.product_id);
    const alert = { id: id(), variant_id: v.id, club_id: v.club_id, status: 'OPEN', available_at_trigger: available, threshold_at_trigger: v.low_stock_threshold, triggered_at: past(at(-1, 15)), resolved_at: null };
    t.low_stock_alerts.push(alert);
    const club = clubById.get(v.club_id);
    t.notification_deliveries.push({
      id: id(), club_id: club.id, recipient_user_id: club.head.id, channel: 'EMAIL', template: 'LOW_STOCK_ALERT', announcement_id: null, destination: club.head.email,
      payload: JSON.stringify({ productName: product.name, sizeLabel: v.size_label, available, threshold: v.low_stock_threshold, inventoryUrl: `/manage/${club.id}/merchandise` }),
      status: 'SENT', attempts: 1, next_attempt_at: alert.triggered_at, last_error: null, provider: 'dev', provider_message_id: `dev-${id()}`, dedupe_key: `low-stock:${alert.id}:${club.head.id}`,
      created_at: alert.triggered_at, sent_at: plus(alert.triggered_at, 60_000), claimed_at: null,
    });
  });

  /* ── Fundraisers and tasks ─────────────────────────────────────────── */
  const mkFundraiser = (club, f) => {
    const fr = { id: id(), club_id: club.id, created_by: club.head.id, description: '', created_at: at(-40), updated_at: at(-40), completed_at: null, ...f };
    t.fundraisers.push(fr);
    return fr;
  };
  const winter = mkFundraiser(sky, { name: 'Winter Clothing Drive', description: 'Collect and distribute 500 warm clothing items to the nearby villages before December.', starts_on: istDate(-20), target_date: istDate(25), goal_amount_paise: 5000000, status: 'ACTIVE' });
  const sponsor = mkFundraiser(sky, { name: 'Tech Fest Sponsorship Drive', description: 'Secure title and associate sponsors for Tech Fest 2026.', starts_on: istDate(-35), target_date: istDate(8), goal_amount_paise: 15000000, status: 'ACTIVE' });
  const library = mkFundraiser(sky, { name: 'Library Book Drive', description: 'Donated 1,200 books to the department libraries.', starts_on: istDate(-120), target_date: istDate(-60), goal_amount_paise: 2000000, status: 'COMPLETED', created_at: at(-125), completed_at: at(-60) });
  mkFundraiser(sky, { name: 'Alumni Meet Fund', description: 'Planning stage. Tasks will be assigned after the GBM.', starts_on: istDate(10), target_date: istDate(90), goal_amount_paise: 8000000, status: 'PLANNING' });
  const mkTask = (f, task) => t.fundraiser_tasks.push({ id: id(), fundraiser_id: f.id, club_id: f.club_id, description: '', status: 'TODO', progress_percent: 0, created_by: asha.id, created_at: at(-18), updated_at: at(-18), completed_at: null, ...task });
  mkTask(winter, { title: 'Design collection posters', assignee_user_id: meera.id, deadline: at(-12), status: 'DONE', progress_percent: 100, completed_at: at(-13) });
  mkTask(winter, { title: 'Set up drop boxes in hostels', assignee_user_id: others[0].id, deadline: at(-5), status: 'DONE', progress_percent: 100, completed_at: at(-6) });
  mkTask(winter, { title: 'Coordinate with NGO for distribution', assignee_user_id: ravi.id, deadline: at(10), status: 'IN_PROGRESS', progress_percent: 60 });
  mkTask(winter, { title: 'Sort and pack donations', assignee_user_id: meera.id, deadline: at(18), status: 'IN_PROGRESS', progress_percent: 35 });
  mkTask(winter, { title: 'Arrange transport (2 vans)', assignee_user_id: others[1].id, deadline: at(20) });
  mkTask(sponsor, { title: 'Prepare sponsorship deck', assignee_user_id: karthik.id, deadline: at(-20), status: 'DONE', progress_percent: 100, completed_at: at(-22) });
  mkTask(sponsor, { title: 'Pitch to 10 local companies', assignee_user_id: meera.id, deadline: at(-2), status: 'IN_PROGRESS', progress_percent: 40 });
  mkTask(sponsor, { title: 'Follow up with alumni network', assignee_user_id: others[2].id, deadline: at(5) });
  mkTask(sponsor, { title: 'Draft sponsor agreements', assignee_user_id: ravi.id, deadline: at(6) });
  mkTask(library, { title: 'Collect books', assignee_user_id: meera.id, deadline: at(-70), status: 'DONE', progress_percent: 100, completed_at: at(-71) });
  mkTask(library, { title: 'Catalogue donations', assignee_user_id: others[0].id, deadline: at(-62), status: 'DONE', progress_percent: 100, completed_at: at(-63) });

  let receiptNo = 1000;
  const income = (f, amountPaise, daysAgo, description) => {
    receiptNo += 1;
    postLedger({ clubId: f.club_id, direction: 'IN', category: 'FUNDRAISER_INCOME', amountPaise, sourceType: 'INCOME_ENTRY', sourceId: id(), fundraiserId: f.id, recordedBy: ravi.id, reference: `RCPT-${receiptNo}`, description, occurredAt: at(-daysAgo, 0) });
  };
  income(winter, 1200000, 15, 'Cash collection, hostel drive');
  income(winter, 850000, 6, 'Faculty contributions');
  income(sponsor, 5000000, 10, 'Associate sponsor: CodeCraft Labs');
  income(library, 1800000, 70, 'Book fair proceeds');

  /* ── Budgets and expenses ──────────────────────────────────────────── */
  const [year, month] = today.split('-').map(Number);
  const halfStart = month - 1 < 6 ? 0 : 6;
  const ymd = (y, m0, d) => new Date(Date.UTC(y, m0, d)).toISOString().slice(0, 10);
  const budget = (name, start, end, amountPaise, notes) => t.budgets.push({ id: id(), club_id: sky.id, name, period_start: start, period_end: end, amount_paise: amountPaise, notes, created_by: ravi.id, created_at: at(-100), updated_at: at(-100) });
  budget(`${halfStart === 6 ? 'Odd' : 'Even'} semester ${year}`, ymd(year, halfStart, 1), ymd(year, halfStart + 6, 0), 40000000, 'Approved in the July GBM.');
  budget(halfStart === 6 ? `Even semester ${year}` : `Odd semester ${year - 1}`, ymd(year, halfStart - 6, 1), ymd(year, halfStart, 0), 30000000, null);

  let payoutNo = 482100;
  const mkExpense = (e) => {
    const kind = e.kind ?? 'REIMBURSEMENT';
    const createdAt = past(at(-e.daysAgo, 10));
    const fileId = id();
    const storageKey = `receipts/demo/receipt-${String(receipts.length + 1).padStart(2, '0')}.pdf`;
    const buffer = receiptPdf(['Campus Flow demo receipt', e.title, `Amount: INR ${(e.amountPaise / 100).toFixed(2)}`, `Submitted by: ${e.submittedBy.full_name}`, 'Sample data for local testing only.']);
    receipts.push({ storageKey, buffer });
    t.uploaded_files.push({
      id: fileId, club_id: sky.id, uploaded_by: e.submittedBy.id, purpose: 'RECEIPT', original_name: (e.receiptName || 'receipt.pdf').replace(/\.(jpg|png)$/i, '.pdf'), storage_key: storageKey,
      mime_type: 'application/pdf', size_bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), created_at: createdAt,
    });
    const ex = {
      id: id(), club_id: sky.id, kind, title: e.title, description: e.description, amount_paise: e.amountPaise, incurred_on: istDate(-e.daysAgo - 1), event_id: e.event?.id ?? null, fundraiser_id: e.fundraiser?.id ?? null,
      receipt_file_id: fileId, submitted_by: e.submittedBy.id, payee_user_id: kind === 'DIRECT' ? null : e.submittedBy.id, status: e.status, decided_by: null, decided_at: null, decision_note: null,
      paid_by: null, paid_at: null, payout_reference: null, created_at: createdAt, updated_at: createdAt,
    };
    if (e.status === 'PAID') {
      ex.paid_by = ravi.id;
      ex.paid_at = past(at(-Math.max(0, e.daysAgo - 2), 15));
      if (kind === 'REIMBURSEMENT') {
        ex.decided_by = ravi.id;
        ex.decided_at = ex.paid_at;
      }
      payoutNo += 137;
      ex.payout_reference = `UPI-${payoutNo}`;
      postLedger({
        clubId: sky.id, direction: 'OUT', category: kind === 'DIRECT' ? 'DIRECT_EXPENSE' : 'REIMBURSEMENT_PAYOUT', amountPaise: ex.amount_paise, sourceType: 'EXPENSE', sourceId: ex.id, expenseId: ex.id,
        eventId: ex.event_id, fundraiserId: ex.fundraiser_id, recordedBy: ravi.id, approvedBy: ex.decided_by, description: ex.title, reference: ex.payout_reference, evidenceFileId: fileId,
        occurredAt: kind === 'DIRECT' ? startOfDay(ex.incurred_on, tz) : ex.paid_at,
      });
    } else if (e.status === 'APPROVED' || e.status === 'REJECTED') {
      ex.decided_by = e.submittedBy.id === ravi.id ? asha.id : ravi.id;
      ex.decided_at = past(at(-Math.max(0, e.daysAgo - 1), 12));
      if (e.status === 'REJECTED') ex.decision_note = 'Receipt is not itemised. Please resubmit with the GST invoice.';
    }
    t.expenses.push(ex);
  };
  mkExpense({ title: 'Sound system rental', description: 'DJ console + speakers for Freshers night', amountPaise: 1800000, kind: 'DIRECT', status: 'PAID', submittedBy: ravi, event: freshers, daysAgo: 31, receiptName: 'sound-invoice.pdf' });
  mkExpense({ title: 'Decorations & lighting', description: 'Fairy lights, banners', amountPaise: 640000, status: 'PAID', submittedBy: meera, event: freshers, daysAgo: 33, receiptName: 'decor-bill.pdf' });
  mkExpense({ title: 'Snacks for volunteers', description: 'Freshers setup team', amountPaise: 185000, status: 'PAID', submittedBy: others[0], event: freshers, daysAgo: 30 });
  mkExpense({ title: 'Poster printing', description: 'A2 posters × 40 for clothing drive', amountPaise: 240000, status: 'PAID', submittedBy: meera, fundraiser: winter, daysAgo: 14 });
  mkExpense({ title: 'Tech Fest venue deposit', description: 'Refundable deposit to the auditorium committee', amountPaise: 2500000, kind: 'DIRECT', status: 'PAID', submittedBy: ravi, event: techFest, daysAgo: 12 });
  mkExpense({ title: 'Hoodie batch, print vendor', description: 'Balance payment for 69 hoodies', amountPaise: 3450000, kind: 'DIRECT', status: 'PAID', submittedBy: ravi, daysAgo: 45 });
  mkExpense({ title: 'Packing boxes', description: 'Cartons and tape for donations', amountPaise: 92000, status: 'APPROVED', submittedBy: meera, fundraiser: winter, daysAgo: 4 });
  mkExpense({ title: 'Speaker travel for Tech Fest', description: 'Cab fare for keynote speaker', amountPaise: 350000, status: 'APPROVED', submittedBy: karthik, event: techFest, daysAgo: 3 });
  mkExpense({ title: 'Lanyards & badges', description: '300 lanyards for Tech Fest', amountPaise: 420000, status: 'SUBMITTED', submittedBy: karthik, event: techFest, daysAgo: 2 });
  mkExpense({ title: 'Courier for sponsor kits', description: 'Shipping sponsor welcome kits', amountPaise: 78000, status: 'SUBMITTED', submittedBy: others[2], fundraiser: sponsor, daysAgo: 1 });
  mkExpense({ title: 'Stationery for GBM', description: 'Registers, pens, markers', amountPaise: 64000, status: 'SUBMITTED', submittedBy: ravi, daysAgo: 1 });
  mkExpense({ title: 'Team dinner', description: 'Post-event dinner', amountPaise: 560000, status: 'REJECTED', submittedBy: others[1], daysAgo: 25 });

  // `head` is a build-time helper on clubs, not a column.
  t.clubs = t.clubs.map(({ head, ...club }) => club); // eslint-disable-line no-unused-vars
  return { tables: t, receipts };
}

async function insertAll(trx, tables) {
  for (const name of INSERT_ORDER) {
    const rows = tables[name];
    for (let i = 0; i < rows.length; i += CHUNK) await trx(name).insert(rows.slice(i, i + CHUNK));
  }
}

/** The payment/ledger/expense checks of LLD §2.10, run on what was just inserted. */
async function assertReconciled(trx) {
  const { rows: byPurpose } = await trx.raw(`
    WITH paid AS (SELECT purpose, sum(amount_paise)::bigint AS total FROM payments WHERE status = 'SUCCEEDED' GROUP BY purpose),
         posted AS (SELECT p.purpose, sum(ft.amount_paise)::bigint AS total FROM financial_transactions ft JOIN payments p ON p.id = ft.payment_id
                     WHERE ft.source_type = 'PAYMENT' AND ft.direction = 'IN' GROUP BY p.purpose)
    SELECT coalesce(paid.purpose, posted.purpose) AS purpose, coalesce(paid.total, 0) AS paid, coalesce(posted.total, 0) AS posted
      FROM paid FULL JOIN posted ON posted.purpose = paid.purpose`);
  const { rows: [out] } = await trx.raw(`
    SELECT (SELECT coalesce(sum(amount_paise), 0) FROM expenses WHERE status = 'PAID')::bigint AS expenses,
           (SELECT coalesce(sum(amount_paise), 0) FROM financial_transactions WHERE direction = 'OUT')::bigint AS ledger_out,
           (SELECT count(*) FROM payments p WHERE p.status = 'SUCCEEDED'
              AND NOT EXISTS (SELECT 1 FROM financial_transactions ft WHERE ft.source_type = 'PAYMENT' AND ft.source_id = p.id))::int AS unposted,
           (SELECT count(*) FROM financial_transactions ft JOIN payments p ON p.id = ft.payment_id WHERE p.status <> 'SUCCEEDED')::int AS orphaned,
           (SELECT count(*) FROM events e WHERE e.seats_reserved <> (SELECT count(*) FROM bookings b WHERE b.event_id = e.id AND b.status IN ('PENDING_PAYMENT', 'CONFIRMED')))::int AS seat_drift`);
  const bad = byPurpose.filter((r) => String(r.paid) !== String(r.posted));
  const problems = [];
  if (bad.length) problems.push(`payments and ledger disagree for ${bad.map((r) => r.purpose).join(', ')}`);
  if (String(out.expenses) !== String(out.ledger_out)) problems.push(`paid expenses ${out.expenses} != ledger out ${out.ledger_out}`);
  if (out.unposted) problems.push(`${out.unposted} succeeded payments have no ledger row`);
  if (out.orphaned) problems.push(`${out.orphaned} ledger rows point at unsettled payments`);
  if (out.seat_drift) problems.push(`${out.seat_drift} events have a wrong seats_reserved`);
  if (problems.length) throw new Error(`Demo data failed its own consistency checks: ${problems.join('; ')}`);
}

/** Receipt PDFs are best-effort: the rows work either way, only the download needs the file. */
async function writeReceipts(receipts) {
  const root = path.resolve(config.UPLOAD_DIR);
  try {
    for (const r of receipts) {
      const full = path.resolve(root, r.storageKey);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, r.buffer);
    }
    return { written: receipts.length, dir: root };
  } catch (err) {
    return { written: 0, dir: root, error: err.code || err.message };
  }
}

/**
 * Inserts the demo data in one transaction. The caller has already checked the target database.
 * With `reset`, every app table is emptied first inside the same transaction, so a failure
 * leaves the database exactly as it was.
 */
export async function seedDemo(knex, { reset = false } = {}) {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const { tables, receipts } = buildDemoData({ passwordHash, verificationKey: config.VERIFICATION_HASH_KEY });
  await knex.transaction(async (trx) => {
    if (reset) await wipeAppData(trx);
    await insertAll(trx, tables);
    await assertReconciled(trx);
  });
  const receiptFiles = await writeReceipts(receipts);
  return { counts: Object.fromEntries(INSERT_ORDER.map((n) => [n, tables[n].length])), receiptFiles };
}
