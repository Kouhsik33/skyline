import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { buildTestContext } from '../helpers/testApp.js';
import { truncateAll } from '../helpers/testDb.js';
import { makeClub, makeUser } from '../fixtures/factories.js';
import { createLogger } from '../../src/shared/logger.js';

// T-50 — outbox enqueue + dispatcher (LLD §2.7, §7; ADR-014). TC-ANN-03, TC-REM-03.

const reminder = (userId, channel, key) => ({
  recipientUserId: userId,
  channel,
  template: 'RENEWAL_REMINDER_7D',
  payload: { clubName: 'Skyline', planName: 'Annual', expiresOn: '2026-11-08', renewUrl: '/me/memberships/m1', autopayEnabled: false },
  dedupeKey: `renewal-reminder:${key}:${channel}`,
});

async function deliveries(db) {
  return db('notification_deliveries').orderBy([{ column: 'channel' }, { column: 'created_at' }]);
}

describe('notifications outbox (T-50)', () => {
  let ctx;
  let user;
  let noPhone;
  const logs = [];
  beforeAll(() => {
    ctx = buildTestContext({
      logger: createLogger({ level: 'info', destination: new Writable({ write: (c, e, cb) => { logs.push(c.toString()); cb(); } }) }),
    });
  });
  afterAll(() => ctx.close());
  beforeEach(async () => {
    await truncateAll(ctx.db);
    user = await makeUser(ctx.db, { phoneE164: '+919876543210' });
    noPhone = await makeUser(ctx.db);
  });
  const enqueue = (items) => ctx.container.withTransaction((trx) => ctx.container.notifications.enqueue(trx, items));
  const dispatch = () => ctx.container.notifications.dispatchPending({ now: ctx.clock.now() });

  it('enqueue snapshots the destination; TC-REM-03: no phone → WhatsApp SKIPPED (NO_CONTACT)', async () => {
    const res = await enqueue([reminder(user.id, 'EMAIL', 't1'), reminder(user.id, 'WHATSAPP', 't1'), reminder(noPhone.id, 'EMAIL', 't2'), reminder(noPhone.id, 'WHATSAPP', 't2')]);
    expect(res).toEqual({ queued: 3, skipped: 1, duplicates: 0 });
    const rows = await deliveries(ctx.db);
    const skipped = rows.find((r) => r.status === 'SKIPPED');
    expect(skipped).toMatchObject({ recipient_user_id: noPhone.id, channel: 'WHATSAPP', last_error: 'NO_CONTACT', destination: null });
    expect(rows.find((r) => r.recipient_user_id === user.id && r.channel === 'WHATSAPP').destination).toBe('+919876543210');
  });

  it('dedupe key: enqueueing twice keeps one row (ON CONFLICT DO NOTHING)', async () => {
    await enqueue([reminder(user.id, 'EMAIL', 't1')]);
    expect(await enqueue([reminder(user.id, 'EMAIL', 't1')])).toEqual({ queued: 0, skipped: 0, duplicates: 1 });
    expect(await deliveries(ctx.db)).toHaveLength(1);
  });

  it('enqueue is part of the caller transaction and validates template payloads', async () => {
    await expect(
      ctx.container.withTransaction(async (trx) => {
        await ctx.container.notifications.enqueue(trx, [reminder(user.id, 'EMAIL', 'rb')]);
        throw new Error('business failure');
      }),
    ).rejects.toThrow('business failure');
    expect(await deliveries(ctx.db)).toHaveLength(0);
    await expect(enqueue([{ ...reminder(user.id, 'EMAIL', 'x'), payload: { clubName: 'S' } }])).rejects.toThrow(/invalid RENEWAL_REMINDER_7D payload/);
    await expect(enqueue([{ ...reminder(user.id, 'EMAIL', 'x'), template: 'NEWSLETTER' }])).rejects.toThrow(/unknown notification template/);
    await expect(ctx.container.notifications.enqueue(null, [])).rejects.toThrow(/transaction/);
  });

  it('dispatch (dev adapters): PENDING → SENT with provider dev; destinations never logged', async () => {
    await enqueue([reminder(user.id, 'EMAIL', 't1'), reminder(user.id, 'WHATSAPP', 't1')]);
    logs.length = 0;
    expect(await dispatch()).toEqual({ recovered: 0, claimed: 2, sent: 2, retried: 0, failed: 0 });
    const rows = await deliveries(ctx.db);
    expect(rows.every((r) => r.status === 'SENT' && r.provider === 'dev' && r.attempts === 1 && r.sent_at)).toBe(true);
    expect(await dispatch()).toMatchObject({ claimed: 0 });
    expect(logs.join('')).not.toContain('+919876543210');
    expect(logs.join('')).not.toContain(user.email);
  });

  it('TC-ANN-03: forced EMAIL failures retry at +1 min and +5 min, then FAILED after 3 attempts; WhatsApp unaffected', async () => {
    const failing = buildTestContext({ configOverrides: { DEV_NOTIFY_FAIL_CHANNEL: 'EMAIL' } });
    try {
      await failing.container.withTransaction(async (trx) => {
        // the business change commits even though delivery will fail (failure isolation, NFR-08)
        await trx('audit_logs').insert({ action: 'ANNOUNCEMENT_PUBLISHED', entity_type: 'announcement' });
        await failing.container.notifications.enqueue(trx, [reminder(user.id, 'EMAIL', 'f'), reminder(user.id, 'WHATSAPP', 'f')]);
      });
      const run = () => failing.container.notifications.dispatchPending({ now: failing.clock.now() });
      const email = () => failing.db('notification_deliveries').where({ channel: 'EMAIL' }).first();
      expect(await run()).toMatchObject({ claimed: 2, sent: 1, retried: 1 });
      expect(await email()).toMatchObject({ status: 'PENDING', attempts: 1, last_error: 'DEV_FORCED_FAILURE' });
      expect((await email()).next_attempt_at.toISOString()).toBe(new Date(failing.clock.now().getTime() + 60_000).toISOString());
      expect(await run()).toMatchObject({ claimed: 0 }); // not due yet
      failing.clock.advance({ minutes: 1 });
      expect(await run()).toMatchObject({ claimed: 1, retried: 1 });
      expect(await email()).toMatchObject({ status: 'PENDING', attempts: 2 });
      failing.clock.advance({ minutes: 4 });
      expect(await run()).toMatchObject({ claimed: 0 });
      failing.clock.advance({ minutes: 1 });
      expect(await run()).toMatchObject({ claimed: 1, failed: 1 });
      expect(await email()).toMatchObject({ status: 'FAILED', attempts: 3 });
      expect((await failing.db('notification_deliveries').where({ channel: 'WHATSAPP' }).first()).status).toBe('SENT');
      expect(await failing.db('audit_logs').where({ action: 'ANNOUNCEMENT_PUBLISHED' })).toHaveLength(1);
    } finally {
      await failing.close();
    }
  });

  it('NOTIFY_MODE=unconfigured: NOT_CONFIGURED fails immediately (no retry)', async () => {
    const unconfigured = buildTestContext({ configOverrides: { NOTIFY_MODE: 'unconfigured' } });
    try {
      await unconfigured.container.withTransaction((trx) => unconfigured.container.notifications.enqueue(trx, [reminder(user.id, 'EMAIL', 'u')]));
      expect(await unconfigured.container.notifications.dispatchPending({ now: unconfigured.clock.now() })).toMatchObject({ failed: 1 });
      expect(await unconfigured.db('notification_deliveries').first()).toMatchObject({ status: 'FAILED', attempts: 1, last_error: 'NOT_CONFIGURED' });
    } finally {
      await unconfigured.close();
    }
  });

  it('a delivery stuck in SENDING for > 10 min is recovered and sent', async () => {
    await enqueue([reminder(user.id, 'EMAIL', 's')]);
    await ctx.db('notification_deliveries').update({ status: 'SENDING', attempts: 1, claimed_at: new Date(ctx.clock.now().getTime() - 11 * 60_000) });
    expect(await dispatch()).toMatchObject({ recovered: 1, claimed: 1, sent: 1 });
    expect(await ctx.db('notification_deliveries').first()).toMatchObject({ status: 'SENT', attempts: 2 });
  });

  it('two dispatchers at once never send the same delivery twice (FOR UPDATE SKIP LOCKED)', async () => {
    const sends = [];
    const counting = { send: async (m) => { sends.push(m.to ?? m.toE164); await new Promise((r) => setTimeout(r, 20)); return { provider: 'count', providerMessageId: String(sends.length) }; } };
    const c = buildTestContext({ notificationAdapters: { EMAIL: counting, WHATSAPP: counting } });
    try {
      const people = await Promise.all(Array.from({ length: 30 }, () => makeUser(c.db)));
      await c.container.withTransaction((trx) => c.container.notifications.enqueue(trx, people.map((p) => reminder(p.id, 'EMAIL', p.id))));
      const results = await Promise.all(Array.from({ length: 4 }, () => c.container.notifications.dispatchPending({ now: c.clock.now(), limit: 10 })));
      expect(results.reduce((s, r) => s + r.sent, 0)).toBe(30);
      expect(sends).toHaveLength(30);
      expect(new Set(sends).size).toBe(30);
    } finally {
      await c.close();
    }
  });
});

describe('migration 012: published announcements are immutable', () => {
  let ctx;
  beforeAll(() => {
    ctx = buildTestContext();
  });
  afterAll(() => ctx.close());

  it('UPDATE/DELETE of a PUBLISHED row raise; drafts can change', async () => {
    await truncateAll(ctx.db);
    const { club, head } = await makeClub(ctx.db);
    const base = { club_id: club.id, title: 'Meet', body: 'Hall A', category: 'MEETING', audience: 'PUBLIC', created_by: head.id };
    const [draft] = await ctx.db('announcements').insert({ ...base, status: 'DRAFT' }).returning('*');
    await ctx.db('announcements').where({ id: draft.id }).update({ title: 'Meet (edited)' });
    const [pub] = await ctx.db('announcements').insert({ ...base, status: 'PUBLISHED', published_by: head.id, published_at: new Date() }).returning('*');
    await expect(ctx.db('announcements').where({ id: pub.id }).update({ title: 'x' })).rejects.toThrow(/published announcements are immutable/); // 012
    await expect(ctx.db('announcements').where({ id: pub.id }).del()).rejects.toThrow(/published announcements are immutable/); // 015
    await ctx.db('announcements').where({ id: draft.id }).del();
    await expect(ctx.db('announcements').insert({ ...base, status: 'PUBLISHED' })).rejects.toThrow(/check constraint/);
  });
});
