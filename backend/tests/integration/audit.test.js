import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestContext } from '../helpers/testApp.js';
import { truncateAll } from '../helpers/testDb.js';
import { makeClub } from '../fixtures/factories.js';
import { audit } from '../../src/shared/audit.js';

// T-24 audit helper: written inside the caller's transaction; append-only.

describe('audit.record', () => {
  let ctx;
  beforeAll(() => {
    ctx = buildTestContext();
  });
  afterAll(() => ctx.close());
  beforeEach(() => truncateAll(ctx.db));

  it('writes a row in the caller transaction and rolls back with it', async () => {
    const { club, head } = await makeClub(ctx.db);
    const row = await ctx.container.withTransaction((trx) =>
      audit.record(trx, { actorUserId: head.id, clubId: club.id, action: 'STOCK_ADJUSTED', entityType: 'product_variant', metadata: { delta: 5 }, requestId: 'req-1' }),
    );
    expect(row).toMatchObject({ action: 'STOCK_ADJUSTED', club_id: club.id, metadata: { delta: 5 }, request_id: 'req-1' });

    await expect(
      ctx.container.withTransaction(async (trx) => {
        await audit.record(trx, { action: 'ROLLED_BACK', entityType: 'x' });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await ctx.db('audit_logs').where({ action: 'ROLLED_BACK' }).first()).toBeUndefined();
  });

  it('is append-only and validates its input', async () => {
    const row = await ctx.container.withTransaction((trx) => audit.record(trx, { action: 'EXPENSE_PAID', entityType: 'expense' }));
    await expect(ctx.db('audit_logs').where({ id: row.id }).update({ action: 'X' })).rejects.toThrow(/forbidden on audit_logs/);
    await expect(ctx.db('audit_logs').where({ id: row.id }).del()).rejects.toThrow(/forbidden on audit_logs/);
    await expect(audit.record(null, { action: 'X', entityType: 'y' })).rejects.toThrow(/transaction/);
    await expect(ctx.container.withTransaction((trx) => audit.record(trx, { action: 'lower', entityType: 'y' }))).rejects.toThrow(
      /UPPER_SNAKE_CASE/,
    );
  });
});
