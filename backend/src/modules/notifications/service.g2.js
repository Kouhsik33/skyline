import { CHANNELS, render, validatePayload } from './templates.js';
import { afterFailure, MAX_ATTEMPTS, STUCK_AFTER_MS } from './domain/retryPolicy.js';
import * as repository from './repository.g2.js';

// Transactional outbox (ADR-014, LLD §2.7, §7).
//   enqueue(trx, items)  — inside the caller's business transaction; ON CONFLICT (dedupe_key)
//                          DO NOTHING; no email/phone -> SKIPPED with last_error NO_CONTACT (OQ-18).
//   dispatchPending()    — outside business transactions: recover stuck SENDING rows, claim due
//                          PENDING rows with SKIP LOCKED, send through the adapter, record outcome.
// Destinations (email/phone) are never logged.

export function createNotificationService({ db, clock, auth, adapters, logger }) {
  // Contacts are read through the caller's transaction: no second pool connection is taken
  // while the business transaction holds one (OQ-59).
  async function contacts(trx, userIds) {
    const unique = [...new Set(userIds)];
    const users = [];
    for (const id of unique) users.push(await auth.getUser(id, { trx }));
    return new Map(unique.map((id, i) => [id, users[i]]));
  }

  /**
   * items: [{ recipientUserId, clubId?, channel, template, payload, dedupeKey, announcementId? }]
   * Returns { queued, skipped, duplicates } counts.
   */
  async function enqueue(trx, items) {
    if (!trx) throw new TypeError('notifications.enqueue requires a transaction');
    if (!items.length) return { queued: 0, skipped: 0, duplicates: 0 };
    const people = await contacts(trx, items.map((i) => i.recipientUserId));
    const now = clock.now();
    const rows = items.map((item) => {
      if (!CHANNELS.includes(item.channel)) throw new TypeError(`unknown channel ${item.channel}`);
      if (!item.dedupeKey) throw new TypeError('dedupeKey is required');
      const payload = validatePayload(item.template, item.payload);
      const user = people.get(item.recipientUserId);
      const destination = item.channel === 'EMAIL' ? user?.email : user?.phoneE164;
      const usable = Boolean(destination) && user?.isActive !== false;
      return {
        club_id: item.clubId ?? null,
        recipient_user_id: item.recipientUserId,
        channel: item.channel,
        template: item.template,
        announcement_id: item.announcementId ?? null,
        destination: usable ? destination : null,
        payload: JSON.stringify(payload),
        status: usable ? 'PENDING' : 'SKIPPED',
        last_error: usable ? null : 'NO_CONTACT',
        next_attempt_at: now,
        dedupe_key: item.dedupeKey,
        created_at: now,
      };
    });
    const inserted = await repository.insertIgnoringDuplicates(trx, rows);
    return {
      queued: inserted.filter((r) => r.status === 'PENDING').length,
      skipped: inserted.filter((r) => r.status === 'SKIPPED').length,
      duplicates: rows.length - inserted.length,
    };
  }

  async function sendOne(row, now) {
    const message = render(row.template, row.payload);
    const adapter = adapters[row.channel];
    try {
      const sent =
        row.channel === 'EMAIL'
          ? await adapter.send({ to: row.destination, subject: message.subject, text: message.text })
          : await adapter.send({ toE164: row.destination, text: message.text });
      await repository.markSent(db, row.id, { ...sent, now });
      return 'sent';
    } catch (err) {
      const retryable = err?.retryable === true;
      const next = afterFailure({ attempts: row.attempts, retryable, now });
      await repository.markFailedAttempt(db, row.id, { ...next, error: err?.code ?? 'SEND_ERROR' });
      if (!err?.code) logger.error({ err, deliveryId: row.id }, 'notifications: unexpected adapter error');
      return next.status === 'FAILED' ? 'failed' : 'retried';
    }
  }

  /** One dispatcher pass (LLD §7 notification-dispatch). */
  async function dispatchPending({ now = clock.now(), limit = 50 } = {}) {
    const recovered = await repository.recoverStuck(db, new Date(now.getTime() - STUCK_AFTER_MS), MAX_ATTEMPTS);
    const claimed = await db.transaction((trx) => repository.claimDue(trx, now, limit));
    const summary = { recovered, claimed: claimed.length, sent: 0, retried: 0, failed: 0 };
    for (const row of claimed) summary[await sendOne(row, now)] += 1;
    return summary;
  }

  async function outbox({ channel, page, pageSize }) {
    const { rows, total } = await repository.listOutbox(db, { channel, limit: pageSize, offset: (page - 1) * pageSize });
    return { rows: rows.map((r) => ({ row: r, message: render(r.template, r.payload) })), total };
  }

  return Object.freeze({ enqueue, dispatchPending, outbox });
}
