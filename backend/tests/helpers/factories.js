import bcrypt from 'bcrypt';
import { randomToken } from '../../src/shared/tokens.js';

export async function createUser(db, overrides = {}) {
  const email = overrides.email ?? `user-${randomToken(4)}@test.skyline.ac.in`;
  const passwordHash = await bcrypt.hash(overrides.password ?? 'TestPass123!', 12);
  const [user] = await db('users')
    .insert({
      email,
      full_name: overrides.fullName ?? 'Test User',
      phone_e164: overrides.phoneE164 ?? null,
      password_hash: passwordHash,
      is_active: true,
    })
    .returning('*');
  return user;
}

export async function createClub(db, overrides = {}) {
  const slug = overrides.slug ?? `club-${randomToken(4)}`;
  const [club] = await db('clubs')
    .insert({
      slug,
      name: overrides.name ?? 'Test Club',
      description: '',
      member_number_prefix: overrides.memberNumberPrefix ?? 'TST',
      is_active: true,
    })
    .returning('*');
  return club;
}

export async function createPlan(db, clubId, createdBy, overrides = {}) {
  const [plan] = await db('membership_plans')
    .insert({
      club_id: clubId,
      name: overrides.name ?? 'Annual',
      fee_paise: overrides.feePaise ?? 50000,
      duration_months: overrides.durationMonths ?? 12,
      event_discount_bps: overrides.eventDiscountBps ?? 1000,
      merch_discount_bps: 0,
      early_bird_access: false,
      status: 'ACTIVE',
      created_by: createdBy,
    })
    .returning('*');
  return plan;
}

export async function verifyStudent(db, userId, studentIdentifier, _fullName = 'Asha Rao') {
  const sid = studentIdentifier ?? `SRKR-TEST-${userId.slice(0, 8)}`;
  const crypto = await import('node:crypto');
  const hash = crypto
    .createHmac('sha256', process.env.VERIFICATION_HASH_KEY || 'dev-key-change-me')
    .update(sid)
    .digest('hex');
  await db('college_verifications').insert({
    user_id: userId,
    outcome: 'VERIFIED',
    student_identifier_hash: hash,
    adapter: 'mock',
    checked_at: new Date(),
  });
}
