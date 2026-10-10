import { todayIST, addDaysToDate } from '../../shared/clock.js';

export function createRenewalRemindersJob({ db: _db, notificationService }) {
  return {
    name: 'renewal-reminders',
    async execute(trx) {
      const today = todayIST();
      const to = addDaysToDate(today, 7);
      const rows = await trx.raw(
        `
        SELECT m.id AS membership_id, t.id AS term_id, m.user_id, m.expires_on, u.email, u.phone_e164, m.club_id
        FROM memberships m
        JOIN membership_terms t ON t.membership_id = m.id AND t.status = 'PAID' AND t.ends_on = m.expires_on
        JOIN users u ON u.id = m.user_id
        WHERE m.status = 'ACTIVE'
          AND m.expires_on BETWEEN ? AND ?
          AND NOT EXISTS (
            SELECT 1 FROM membership_terms p
            WHERE p.membership_id = m.id AND p.status = 'PAID' AND p.starts_on > m.expires_on
          )
        `,
        [addDaysToDate(today, 1), to],
      );

      let queued = 0;
      for (const row of rows.rows ?? []) {
        const dedupeEmail = `renewal-reminder:${row.term_id}:EMAIL`;
        const exists = await trx('notification_deliveries').where({ dedupe_key: dedupeEmail }).first();
        if (exists) continue;

        await notificationService.enqueue(trx, {
          clubId: row.club_id,
          recipientUserId: row.user_id,
          channel: 'EMAIL',
          template: 'RENEWAL_REMINDER_7D',
          destination: row.email,
          dedupeKey: dedupeEmail,
          payload: { expiresOn: row.expires_on },
        });
        queued += 1;

        if (row.phone_e164) {
          await notificationService.enqueue(trx, {
            clubId: row.club_id,
            recipientUserId: row.user_id,
            channel: 'WHATSAPP',
            template: 'RENEWAL_REMINDER_7D',
            destination: row.phone_e164,
            dedupeKey: `renewal-reminder:${row.term_id}:WHATSAPP`,
            payload: { expiresOn: row.expires_on },
          });
        } else {
          await notificationService.enqueue(trx, {
            clubId: row.club_id,
            recipientUserId: row.user_id,
            channel: 'WHATSAPP',
            template: 'RENEWAL_REMINDER_7D',
            dedupeKey: `renewal-reminder:${row.term_id}:WHATSAPP`,
            payload: { expiresOn: row.expires_on },
            status: 'SKIPPED',
            lastError: 'NO_CONTACT',
          });
        }
      }
      return { queued };
    },
  };
}
