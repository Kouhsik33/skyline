import { toCamelCase } from '../../../shared/caseMap.js';

export function createPaymentRepository({ db }) {
  return {
    async findById(id, trx = db) {
      const row = await trx('payments').where({ id }).first();
      return row ? toCamelCase(row) : null;
    },

    async findByIdForUpdate(id, trx) {
      const row = await trx('payments').where({ id }).forUpdate().first();
      return row ? toCamelCase(row) : null;
    },

    async insert(row, trx) {
      const [inserted] = await trx('payments').insert(row).returning('*');
      return toCamelCase(inserted);
    },

    async settle(id, outcome, failureReason, trx) {
      const [updated] = await trx('payments')
        .where({ id })
        .whereIn('status', ['INITIATED', 'PENDING'])
        .update({
          status: outcome,
          failure_reason: failureReason ?? null,
          settled_at: trx.fn.now(),
          updated_at: trx.fn.now(),
        })
        .returning('*');
      return updated ? toCamelCase(updated) : null;
    },

    async listByUser(userId, filters, trx = db) {
      let q = trx('payments').where({ user_id: userId }).orderBy('created_at', 'desc');
      if (filters.purpose) q = q.andWhere({ purpose: filters.purpose });
      if (filters.status) q = q.andWhere({ status: filters.status });
      if (filters.offset) q = q.offset(filters.offset);
      const rows = await q.limit(filters.limit ?? 50);
      return rows.map(toCamelCase);
    },

    async countByUser(userId, filters, trx = db) {
      let q = trx('payments').where({ user_id: userId });
      if (filters.purpose) q = q.andWhere({ purpose: filters.purpose });
      if (filters.status) q = q.andWhere({ status: filters.status });
      const [{ n }] = await q.count({ n: '*' });
      return Number(n);
    },

    async listByClub(clubId, filters, trx = db) {
      let q = trx('payments').where({ club_id: clubId }).orderBy('created_at', 'desc');
      if (filters.purpose) q = q.andWhere({ purpose: filters.purpose });
      if (filters.status) q = q.andWhere({ status: filters.status });
      const rows = await q.limit(filters.limit ?? 50);
      return rows.map(toCamelCase);
    },
  };
}
