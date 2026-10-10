import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestContext, idemKey } from '../helpers/testApp.js';
import { truncateAll } from '../helpers/testDb.js';
import { approve, ledgerOut, markPaid, reject, submitExpense } from '../helpers/finance.js';
import { assignRole, makeClub, makeEventWithOrganizer, makeFundraiser, makeUser } from '../fixtures/factories.js';
import { EXE, JPEG, PDF, TEXT, pdfOfSize } from '../fixtures/files.js';

// T-80 / T-81 — LLD §4.9, §5.11, §8. TC-FIN-01, TC-FIN-02, TC-FIN-06.

const UPLOAD_ROOT = '/tmp/soms-test-uploads';

async function storedFiles() {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(path.relative(UPLOAD_ROOT, p));
    }
  }
  await walk(UPLOAD_ROOT);
  return out.sort();
}

describe('expenses (T-80, T-81)', () => {
  let ctx;
  let club;
  let other;
  let volunteer;
  let organizer;
  beforeAll(() => {
    ctx = buildTestContext();
  });
  afterAll(() => ctx.close());
  beforeEach(async () => {
    await truncateAll(ctx.db);
    volunteer = await makeUser(ctx.db, { fullName: 'Vol One' });
    organizer = await makeUser(ctx.db, { fullName: 'Org One' });
    club = await makeClub(ctx.db, { volunteers: [volunteer] });
    other = await makeClub(ctx.db);
    await makeEventWithOrganizer(ctx.db, { club: club.club, head: club.head, organizer });
  });

  describe('submit', () => {
    it('volunteer submits a reimbursement: SUBMITTED, payee = submitter, no ledger, audited', async () => {
      const res = await submitExpense(await ctx.signIn(volunteer.id), club.club.id, { description: 'Posters', amountPaise: '25000' });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        kind: 'REIMBURSEMENT',
        status: 'SUBMITTED',
        amountPaise: 25000,
        incurredOn: '2026-10-28',
        submittedBy: { id: volunteer.id, fullName: 'Vol One' },
        payee: { id: volunteer.id },
        receipt: { originalName: 'bill.png', mimeType: 'image/png' },
      });
      expect(JSON.stringify(res.body)).not.toContain('receipts/');
      expect(await ledgerOut(ctx.db, res.body.data.id)).toHaveLength(0);
      expect(await ctx.db('audit_logs').where({ action: 'EXPENSE_SUBMITTED', entity_id: res.body.data.id })).toHaveLength(1);
    });

    it('event organizers (TEAM) may submit reimbursements', async () => {
      const res = await submitExpense(await ctx.signIn(organizer.id), club.club.id);
      expect(res.status).toBe(201);
    });

    it('treasurer records a direct expense: PAID immediately + ledger OUT DIRECT_EXPENSE in the same transaction', async () => {
      const res = await submitExpense(await ctx.signIn(club.treasurer.id), club.club.id, { kind: 'DIRECT', amountPaise: '12000', incurredOn: '2026-10-29' }, { file: { buffer: PDF, filename: 'inv.pdf' } });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ kind: 'DIRECT', status: 'PAID', payee: null, paidBy: { id: club.treasurer.id } });
      const [row] = await ledgerOut(ctx.db, res.body.data.id);
      expect(row).toMatchObject({ direction: 'OUT', category: 'DIRECT_EXPENSE', amount_paise: 12000, recorded_by: club.treasurer.id, expense_id: res.body.data.id });
      expect(row.occurred_at.toISOString()).toBe('2026-10-28T18:30:00.000Z'); // 2026-10-29 00:00 IST (OQ-16)
      expect(await ctx.db('audit_logs').where({ action: 'DIRECT_EXPENSE_RECORDED' })).toHaveLength(1);
    });

    it('volunteer and club head cannot record a direct expense (403); outsiders get 404', async () => {
      const before = await storedFiles();
      for (const [user, status] of [[volunteer, 403], [club.head, 403], [other.treasurer, 404]]) {
        const res = await submitExpense(await ctx.signIn(user.id), club.club.id, { kind: 'DIRECT' });
        expect(res.status).toBe(status);
      }
      expect(await ctx.db('expenses')).toHaveLength(0);
      expect(await storedFiles()).toEqual(before);
    });

    it('TC-FIN-06: .exe renamed .pdf → 415; 5 MB + 1 byte → 413; exactly 5 MB PDF accepted; missing receipt → 400', async () => {
      const vol = await ctx.signIn(volunteer.id);
      const before = await storedFiles();
      const exe = await submitExpense(vol, club.club.id, {}, { file: { buffer: EXE, filename: 'receipt.pdf' } });
      expect(exe.status).toBe(415);
      expect(exe.body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
      const txt = await submitExpense(vol, club.club.id, {}, { file: { buffer: TEXT, filename: 'receipt.png' } });
      expect(txt.body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
      const big = await submitExpense(vol, club.club.id, {}, { file: { buffer: pdfOfSize(5242881), filename: 'big.pdf' } });
      expect(big.status).toBe(413);
      expect(big.body.error.code).toBe('FILE_TOO_LARGE');
      const none = await submitExpense(vol, club.club.id, {}, { file: null });
      expect(none.status).toBe(400);
      expect(none.body.error.code).toBe('RECEIPT_REQUIRED');
      expect(await ctx.db('expenses')).toHaveLength(0);
      expect(await storedFiles()).toEqual(before);
      const max = await submitExpense(vol, club.club.id, {}, { file: { buffer: pdfOfSize(5242880), filename: 'max.pdf' } });
      expect(max.status).toBe(201);
    });

    it('stored under a random key with mode 0640; metadata row has sha256; original name kept only as metadata', async () => {
      const before = await storedFiles();
      const res = await submitExpense(await ctx.signIn(volunteer.id), club.club.id, {}, { file: { buffer: JPEG, filename: '../../evil name.jpg' } });
      expect(res.status).toBe(201);
      const added = (await storedFiles()).filter((f) => !before.includes(f));
      expect(added).toHaveLength(1);
      expect(added[0]).toMatch(/^receipts\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/);
      expect((await stat(path.join(UPLOAD_ROOT, added[0]))).mode & 0o777).toBe(0o640);
      const file = await ctx.db('uploaded_files').where({ id: res.body.data.receipt.fileId }).first();
      expect(file).toMatchObject({ storage_key: added[0], mime_type: 'image/jpeg', size_bytes: JPEG.length, original_name: 'evil name.jpg', purpose: 'RECEIPT' });
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('event/fundraiser must belong to the club (events.getEventClub stub: matching, other club, unknown)', async () => {
      const vol = await ctx.signIn(volunteer.id);
      const ownEvent = await makeEventWithOrganizer(ctx.db, { club: club.club, head: club.head });
      const otherEvent = await makeEventWithOrganizer(ctx.db, { club: other.club, head: other.head });
      expect((await submitExpense(vol, club.club.id, { eventId: ownEvent.id })).status).toBe(201);
      for (const eventId of [otherEvent.id, crypto.randomUUID()]) {
        const res = await submitExpense(vol, club.club.id, { eventId });
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('EVENT_NOT_IN_CLUB');
      }
      const otherF = await makeFundraiser(ctx.db, other);
      const ownF = await makeFundraiser(ctx.db, club);
      expect((await submitExpense(vol, club.club.id, { fundraiserId: otherF.id })).body.error.code).toBe('FUNDRAISER_NOT_IN_CLUB');
      expect((await submitExpense(vol, club.club.id, { fundraiserId: crypto.randomUUID() })).body.error.code).toBe('FUNDRAISER_NOT_IN_CLUB');
      expect((await submitExpense(vol, club.club.id, { fundraiserId: ownF.id })).status).toBe(201);
      const both = await submitExpense(vol, club.club.id, { eventId: ownEvent.id, fundraiserId: ownF.id });
      expect(both.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('OQ-53: no new expense links to a COMPLETED or CANCELLED fundraiser (409 FUNDRAISER_CLOSED), reimbursement or direct', async () => {
      const before = await storedFiles();
      for (const status of ['COMPLETED', 'CANCELLED']) {
        const f = await makeFundraiser(ctx.db, club, { status });
        for (const [user, kind] of [[volunteer, 'REIMBURSEMENT'], [club.treasurer, 'DIRECT']]) {
          const res = await submitExpense(await ctx.signIn(user.id), club.club.id, { kind, fundraiserId: f.id });
          expect(res.status).toBe(409);
          expect(res.body.error).toMatchObject({ code: 'FUNDRAISER_CLOSED', details: { fundraiserStatus: status } });
        }
      }
      expect(await ctx.db('expenses')).toHaveLength(0);
      expect(await ctx.db('financial_transactions')).toHaveLength(0);
      expect(await storedFiles()).toEqual(before);
      for (const status of ['PLANNING', 'ACTIVE']) {
        const f = await makeFundraiser(ctx.db, club, { status });
        expect((await submitExpense(await ctx.signIn(volunteer.id), club.club.id, { fundraiserId: f.id })).status).toBe(201);
      }
    });

    it('validation: decimal or zero amount, future incurredOn, unknown kind, missing title', async () => {
      const vol = await ctx.signIn(volunteer.id);
      for (const fields of [{ amountPaise: '250.50' }, { amountPaise: '0' }, { amountPaise: '-5' }, { incurredOn: '2026-11-02' }, { kind: 'GIFT' }, { title: '' }]) {
        const res = await submitExpense(vol, club.club.id, fields);
        expect(res.status, JSON.stringify(fields)).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
    });

    it('if the transaction fails after the file is saved, the stored file is deleted', async () => {
      // The getEventClub stub vouches for an event id that does not exist, so the expense
      // insert violates the events FK after the file has been written.
      const ghost = crypto.randomUUID();
      const failing = buildTestContext({ group1Overrides: { events: { getEventClub: async () => club.club.id } } });
      try {
        const before = await storedFiles();
        const res = await submitExpense(await failing.signIn(volunteer.id), club.club.id, { eventId: ghost });
        expect(res.status).toBe(500);
        expect(await storedFiles()).toEqual(before);
        expect(await ctx.db('uploaded_files')).toHaveLength(0);
      } finally {
        await failing.close();
      }
    });
  });

  describe('review and payout', () => {
    async function submitted(by = volunteer) {
      const res = await submitExpense(await ctx.signIn(by.id), club.club.id, { amountPaise: '25000', incurredOn: '2026-10-20' });
      expect(res.status).toBe(201);
      return res.body.data;
    }

    it('TC-FIN-02: submit → approve → mark paid; ledger OUT only after PAID', async () => {
      const e = await submitted();
      const tr = await ctx.signIn(club.treasurer.id);
      const ok = await approve(tr, e.id, { note: 'fine' });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({ status: 'APPROVED', decidedBy: { id: club.treasurer.id }, decisionNote: 'fine', decidedAt: ctx.clock.now().toISOString() });
      expect(await ledgerOut(ctx.db, e.id)).toHaveLength(0);

      const paid = await markPaid(tr, e.id, { payoutReference: 'UPI-77', paidOn: '2026-10-31' });
      expect(paid.status).toBe(200);
      expect(paid.body.data).toMatchObject({ status: 'PAID', paidBy: { id: club.treasurer.id }, payoutReference: 'UPI-77' });
      const rows = await ledgerOut(ctx.db, e.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ category: 'REIMBURSEMENT_PAYOUT', amount_paise: 25000, recorded_by: club.treasurer.id, approved_by: club.treasurer.id, reference: 'UPI-77' });
      expect(rows[0].occurred_at.toISOString()).toBe('2026-10-30T18:30:00.000Z');
      expect((await ctx.db('audit_logs').whereIn('action', ['EXPENSE_APPROVED', 'EXPENSE_PAID'])).length).toBe(2);
    });

    it('reject requires a note; rejected claims cannot be paid or approved', async () => {
      const e = await submitted();
      const tr = await ctx.signIn(club.treasurer.id);
      expect((await reject(tr, e.id, {})).body.error.code).toBe('VALIDATION_FAILED');
      const res = await reject(tr, e.id, { note: 'Duplicate' });
      expect(res.body.data).toMatchObject({ status: 'REJECTED', decisionNote: 'Duplicate' });
      expect((await approve(tr, e.id)).body.error).toMatchObject({ code: 'CONFLICT_STATE', details: { currentStatus: 'REJECTED' } });
      expect((await markPaid(tr, e.id)).body.error.code).toBe('CONFLICT_STATE');
      expect(await ledgerOut(ctx.db, e.id)).toHaveLength(0);
    });

    it('double approve: one transition, the second is CONFLICT_STATE', async () => {
      const e = await submitted();
      const tr = await ctx.signIn(club.treasurer.id);
      expect((await approve(tr, e.id)).status).toBe(200);
      const second = await approve(tr, e.id);
      expect(second.status).toBe(409);
      expect(second.body.error).toMatchObject({ code: 'CONFLICT_STATE', details: { currentStatus: 'APPROVED' } });
    });

    it('mark-paid needs APPROVED, a payout reference and a sane paidOn', async () => {
      const e = await submitted();
      const tr = await ctx.signIn(club.treasurer.id);
      expect((await markPaid(tr, e.id)).body.error).toMatchObject({ code: 'CONFLICT_STATE', details: { currentStatus: 'SUBMITTED' } });
      await approve(tr, e.id);
      expect((await markPaid(tr, e.id, { paidOn: '2026-10-30' })).body.error.code).toBe('VALIDATION_FAILED');
      expect((await markPaid(tr, e.id, { payoutReference: 'X', paidOn: '2026-10-19' })).body.error.code).toBe('VALIDATION_FAILED'); // before incurredOn
      expect((await markPaid(tr, e.id, { payoutReference: 'X', paidOn: '2026-11-02' })).body.error.code).toBe('VALIDATION_FAILED'); // future
      expect(await ledgerOut(ctx.db, e.id)).toHaveLength(0);
    });

    it('TC-FIN-01: volunteer 403, treasurer self-approval SELF_APPROVAL_FORBIDDEN, other-club treasurer 404', async () => {
      const volClaim = await submitted();
      expect((await approve(await ctx.signIn(volunteer.id), volClaim.id)).body.error.code).toBe('FORBIDDEN');
      const otherVol = await makeUser(ctx.db);
      await assignRole(ctx.db, club.club.id, otherVol.id, 'VOLUNTEER');
      expect((await approve(await ctx.signIn(otherVol.id), volClaim.id)).status).toBe(403);
      expect((await approve(await ctx.signIn(other.treasurer.id), volClaim.id)).status).toBe(404);

      const trClaim = await submitted(club.treasurer);
      const self = await approve(await ctx.signIn(club.treasurer.id), trClaim.id);
      expect(self.status).toBe(403);
      expect(self.body.error.code).toBe('SELF_APPROVAL_FORBIDDEN');
      // OD-06: the club head approves the treasurer's claim
      expect((await approve(await ctx.signIn(club.head.id), trClaim.id)).status).toBe(200);
      // ... and a club head cannot approve an ordinary volunteer claim
      expect((await approve(await ctx.signIn(club.head.id), volClaim.id)).body.error.code).toBe('FORBIDDEN');
    });

    it('OQ-44: several treasurers — another treasurer may approve AND pay out a treasurer’s claim', async () => {
      const tr2 = await makeUser(ctx.db, { fullName: 'Second Treasurer' });
      await assignRole(ctx.db, club.club.id, tr2.id, 'TREASURER');
      const claim = await submitted(club.treasurer);
      const second = await ctx.signIn(tr2.id);
      expect((await approve(second, claim.id)).status).toBe(200);
      expect((await markPaid(await ctx.signIn(club.treasurer.id), claim.id)).body.error.code).toBe('SELF_PAYOUT_FORBIDDEN');
      expect((await markPaid(await ctx.signIn(volunteer.id), claim.id)).body.error.code).toBe('FORBIDDEN');
      const paid = await markPaid(second, claim.id);
      expect(paid.status).toBe(200);
      expect(paid.body.data.paidBy.id).toBe(tr2.id);
      expect(await ledgerOut(ctx.db, claim.id)).toHaveLength(1);
    });

    it('OQ-44: a sole treasurer’s claim is paid by the club head', async () => {
      const claim = await submitted(club.treasurer);
      await approve(await ctx.signIn(club.head.id), claim.id);
      expect((await markPaid(await ctx.signIn(club.treasurer.id), claim.id)).body.error.code).toBe('SELF_PAYOUT_FORBIDDEN');
      expect((await markPaid(await ctx.signIn(club.head.id), claim.id)).status).toBe(200);
    });

    it('OQ-44: a head-and-treasurer payee is paid only by another club head, not by a treasurer', async () => {
      await assignRole(ctx.db, club.club.id, club.head.id, 'TREASURER');
      const head2 = await makeUser(ctx.db);
      await assignRole(ctx.db, club.club.id, head2.id, 'CLUB_HEAD');
      const claim = await submitted(club.head);
      await approve(await ctx.signIn(head2.id), claim.id);
      expect((await markPaid(await ctx.signIn(club.treasurer.id), claim.id)).body.error.code).toBe('FORBIDDEN');
      expect((await markPaid(await ctx.signIn(head2.id), claim.id)).status).toBe(200);
    });

    it('head who is also treasurer: own claim needs another club head', async () => {
      await assignRole(ctx.db, club.club.id, club.head.id, 'TREASURER');
      const head2 = await makeUser(ctx.db);
      await assignRole(ctx.db, club.club.id, head2.id, 'CLUB_HEAD');
      const claim = await submitted(club.head);
      expect((await approve(await ctx.signIn(club.head.id), claim.id)).body.error.code).toBe('SELF_APPROVAL_FORBIDDEN');
      expect((await approve(await ctx.signIn(club.treasurer.id), claim.id)).body.error.code).toBe('FORBIDDEN');
      expect((await approve(await ctx.signIn(head2.id), claim.id)).status).toBe(200);
    });

    it('SELF_PAYOUT_FORBIDDEN: a treasurer cannot pay out their own approved claim', async () => {
      const claim = await submitted(club.treasurer);
      await approve(await ctx.signIn(club.head.id), claim.id);
      const res = await markPaid(await ctx.signIn(club.treasurer.id), claim.id);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('SELF_PAYOUT_FORBIDDEN');
    });

    it('volunteer cannot mark paid; direct expenses cannot be approved', async () => {
      const claim = await submitted();
      await approve(await ctx.signIn(club.treasurer.id), claim.id);
      expect((await markPaid(await ctx.signIn(volunteer.id), claim.id)).body.error.code).toBe('FORBIDDEN');
      const direct = await submitExpense(await ctx.signIn(club.treasurer.id), club.club.id, { kind: 'DIRECT' });
      expect((await approve(await ctx.signIn(club.head.id), direct.body.data.id)).body.error.code).toBe('CONFLICT_STATE');
    });
  });

  describe('reads and receipt download', () => {
    it('GET /expenses/:id and /receipt: CH, TR, submitter allowed; other volunteer 403; other club 404; anonymous 401', async () => {
      const res = await submitExpense(await ctx.signIn(volunteer.id), club.club.id, {}, { file: { buffer: PDF, filename: 'bill.pdf' } });
      const id = res.body.data.id;
      const vol2 = await makeUser(ctx.db);
      await assignRole(ctx.db, club.club.id, vol2.id, 'VOLUNTEER');
      for (const [user, status] of [[volunteer, 200], [club.head, 200], [club.treasurer, 200], [vol2, 403], [other.head, 404], [organizer, 403]]) {
        const agent = await ctx.signIn(user.id);
        expect((await agent.get(`/api/v1/expenses/${id}`)).status).toBe(status);
        expect((await agent.get(`/api/v1/expenses/${id}/receipt`)).status).toBe(status);
      }
      expect((await request(ctx.app).get(`/api/v1/expenses/${id}/receipt`)).status).toBe(401);
    });

    it('receipt is served as an attachment with nosniff and no-store', async () => {
      const res = await submitExpense(await ctx.signIn(volunteer.id), club.club.id, {}, { file: { buffer: PDF, filename: 'bill.pdf' } });
      const dl = await (await ctx.signIn(club.treasurer.id)).get(`/api/v1/expenses/${res.body.data.id}/receipt`).buffer(true).parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(dl.status).toBe(200);
      expect(dl.headers['content-type']).toBe('application/pdf');
      expect(dl.headers['content-disposition']).toBe(`attachment; filename="receipt-${res.body.data.id}.pdf"`);
      expect(dl.headers['x-content-type-options']).toBe('nosniff');
      expect(dl.headers['cache-control']).toBe('private, no-store');
      expect(Buffer.compare(dl.body, PDF)).toBe(0);
    });

    it('club list (CH, TR) with filters; /me/expenses shows own submissions only', async () => {
      const vol = await ctx.signIn(volunteer.id);
      const a = await submitExpense(vol, club.club.id);
      await submitExpense(await ctx.signIn(club.treasurer.id), club.club.id, { kind: 'DIRECT' });
      await submitExpense(await ctx.signIn(other.treasurer.id), other.club.id, { kind: 'DIRECT' });
      const list = await (await ctx.signIn(club.head.id)).get(`/api/v1/clubs/${club.club.id}/expenses`);
      expect(list.body.total).toBe(2);
      const direct = await (await ctx.signIn(club.treasurer.id)).get(`/api/v1/clubs/${club.club.id}/expenses?kind=DIRECT&status=PAID`);
      expect(direct.body.total).toBe(1);
      expect((await vol.get(`/api/v1/clubs/${club.club.id}/expenses`)).status).toBe(403);
      const mine = await vol.get('/api/v1/me/expenses');
      expect(mine.body.data.map((e) => e.id)).toEqual([a.body.data.id]);
    });
  });

  describe('idempotency of state changes', () => {
    it('replayed submit, approve and mark-paid return the stored response and create no duplicates', async () => {
      const vol = await ctx.signIn(volunteer.id);
      const key = idemKey();
      const first = await submitExpense(vol, club.club.id, {}, { key });
      const replay = await submitExpense(vol, club.club.id, {}, { key });
      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(first.body);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(await ctx.db('expenses')).toHaveLength(1);
      expect(await ctx.db('uploaded_files')).toHaveLength(1);

      const different = await submitExpense(vol, club.club.id, {}, { key, file: { buffer: PDF, filename: 'bill.png' } });
      expect(different.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

      const tr = await ctx.signIn(club.treasurer.id);
      const id = first.body.data.id;
      const k2 = idemKey();
      const a1 = await approve(tr, id, {}, k2);
      const a2 = await approve(tr, id, {}, k2);
      expect(a2.status).toBe(200);
      expect(a2.body).toEqual(a1.body);

      const k3 = idemKey();
      const p1 = await markPaid(tr, id, undefined, k3);
      const p2 = await markPaid(tr, id, undefined, k3);
      expect(p2.status).toBe(200);
      expect(p2.body).toEqual(p1.body);
      expect(await ledgerOut(ctx.db, id)).toHaveLength(1);
      expect(await ctx.db('audit_logs').where({ entity_id: id })).toHaveLength(3);
    });
  });
});
