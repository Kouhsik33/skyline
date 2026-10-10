// notification_deliveries (outbox) data access.

export async function insertIgnoringDuplicates(trx, rows) {
  if (!rows.length) return [];
  return trx('notification_deliveries').insert(rows).onConflict('dedupe_key').ignore().returning('*');
}

/** SENDING rows claimed before `cutoff` are treated as crashed claims. */
export async function recoverStuck(conn, cutoff, maxAttempts) {
  const failed = await conn('notification_deliveries')
    .where({ status: 'SENDING' })
    .where('claimed_at', '<', cutoff)
    .where('attempts', '>=', maxAttempts)
    .update({ status: 'FAILED', last_error: 'STUCK_IN_SENDING' }, ['id']);
  const requeued = await conn('notification_deliveries')
    .where({ status: 'SENDING' })
    .where('claimed_at', '<', cutoff)
    .update({ status: 'PENDING', last_error: 'STUCK_IN_SENDING' }, ['id']);
  return failed.length + requeued.length;
}

/** Claims up to `limit` due PENDING rows (FOR UPDATE SKIP LOCKED), marking them SENDING. */
export async function claimDue(trx, now, limit) {
  const { rows } = await trx.raw(
    `UPDATE notification_deliveries d
        SET status = 'SENDING', claimed_at = ?, attempts = d.attempts + 1
      WHERE d.id IN (
        SELECT id FROM notification_deliveries
         WHERE status = 'PENDING' AND next_attempt_at <= ?
         ORDER BY next_attempt_at, id
         LIMIT ?
         FOR UPDATE SKIP LOCKED)
      RETURNING d.*`,
    [now, now, limit],
  );
  return rows;
}

export async function markSent(conn, id, { provider, providerMessageId, now }) {
  return conn('notification_deliveries')
    .where({ id, status: 'SENDING' })
    .update({ status: 'SENT', sent_at: now, provider, provider_message_id: providerMessageId, last_error: null });
}

export async function markFailedAttempt(conn, id, { status, nextAttemptAt, error }) {
  const changes = { status, last_error: error };
  if (nextAttemptAt) changes.next_attempt_at = nextAttemptAt;
  return conn('notification_deliveries').where({ id, status: 'SENDING' }).update(changes);
}

export async function listOutbox(conn, { channel, limit, offset }) {
  const base = conn('notification_deliveries');
  if (channel) base.where({ channel });
  const [{ count }] = await base.clone().count({ count: '*' });
  const rows = await base.clone().orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(limit).offset(offset);
  return { rows, total: count };
}
