import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestContext, idemKey } from '../helpers/testApp.js';
import { truncateAll } from '../helpers/testDb.js';
import { verifyStudent } from '../helpers/factories.js';
import { makeCast } from '../helpers/authzMatrix.js';
import { makeProduct, makeUser } from '../fixtures/factories.js';

// T-92 security checks on the merged app (both groups):
//   1. every state-changing route needs X-Requested-With: soms (login/register exempt)
//   2. every [IDEM] route of LLD §4 refuses a missing Idempotency-Key
//   3. club-scoped management routes: other club → 404, same club without the role → 403
//   4. no string-built SQL in src/
//   5. no float money (grep + BIGINT-only paise columns: tests/unit/noFloatMoney, integration/migrations)
//   6. no trusted client prices: expected*Paise is compared, never charged; price fields rejected

const H = { 'X-Requested-With': 'soms' };
const U = '00000000-0000-4000-8000-000000000000';

function routes(app) {
  const out = [];
  const walk = (stack) => {
    for (const l of stack) {
      if (l.route) for (const m of Object.keys(l.route.methods)) out.push({ method: m.toUpperCase(), path: l.route.path });
      else if (l.handle?.stack) walk(l.handle.stack);
    }
  };
  walk(app.router.stack);
  return out;
}
const concrete = (p) => `/api/v1${p.replace(/:[A-Za-z]+/g, U)}`;

describe('T-92 security checks', () => {
  let ctx;
  let cast;
  beforeAll(async () => {
    ctx = buildTestContext();
    await truncateAll(ctx.db);
    cast = await makeCast(ctx);
  });
  afterAll(() => ctx.close());

  it('1. X-Requested-With: every mutating route rejects a request without it (403 FORBIDDEN)', async () => {
    const mutating = routes(ctx.app).filter((r) => r.method !== 'GET' && !/^\/auth\/(login|register)$|^\/__test\//.test(r.path));
    expect(mutating.length).toBeGreaterThanOrEqual(40);
    const failures = [];
    for (const r of mutating) {
      const res = await cast.agents.CH_A[r.method.toLowerCase()](concrete(r.path)).send({});
      if (!(res.status === 403 && res.body.error?.details?.reason === 'CSRF_HEADER_MISSING')) failures.push(`${r.method} ${r.path} → ${res.status}`);
    }
    expect(failures.join("\n")).toBe("");
  });

  // LLD §4 routes marked [IDEM]
  const IDEM = [
    'POST /clubs/:clubId/memberships',
    'POST /me/memberships/:membershipId/renewals',
    'POST /payments/:paymentId/simulate',
    'POST /events/:eventId/bookings',
    'POST /events/:eventId/check-ins',
    'POST /announcements/:id/publish',
    'POST /variants/:variantId/stock-adjustments',
    'POST /clubs/:clubId/orders',
    'POST /clubs/:clubId/pickups',
    'POST /clubs/:clubId/expenses',
    'POST /expenses/:id/approve',
    'POST /expenses/:id/reject',
    'POST /expenses/:id/mark-paid',
    'POST /clubs/:clubId/income-entries',
  ];
  it('2. every [IDEM] route is mounted and refuses a missing Idempotency-Key (400 IDEMPOTENCY_KEY_REQUIRED)', async () => {
    const mounted = new Set(routes(ctx.app).map((r) => `${r.method} ${r.path}`));
    const failures = [];
    for (const spec of IDEM) {
      if (!mounted.has(spec)) {
        failures.push(`${spec} not mounted`);
        continue;
      }
      const [method, p] = spec.split(' ');
      const res = await cast.agents.CH_A[method.toLowerCase()](concrete(p)).set(H).send({});
      if (!(res.status === 400 && res.body.error.code === 'IDEMPOTENCY_KEY_REQUIRED')) failures.push(`${spec} → ${res.status} ${res.body.error?.code}`);
    }
    expect(failures.join("\n")).toBe("");
  });

  it('3. club-scoped management routes: other club → 404; same club without the role → 403', async () => {
    const A = cast.a.club.id;
    const cases = [
      ['get', `/api/v1/clubs/${A}/roles`, {}],
      ['post', `/api/v1/clubs/${A}/roles`, { userEmail: 'x@example.test', role: 'VOLUNTEER' }],
      ['post', `/api/v1/clubs/${A}/plans`, { name: 'P', feePaise: 100, durationMonths: 1 }],
      ['post', `/api/v1/clubs/${A}/events`, { title: 'E', venue: 'Hall', startsAt: '2027-06-01T18:00:00.000Z', endsAt: '2027-06-01T22:00:00.000Z', registrationOpensAt: '2026-10-01T00:00:00.000Z', registrationClosesAt: '2027-05-31T00:00:00.000Z', capacity: 10, memberPricePaise: 100, nonMemberPricePaise: 200 }],
      ['post', `/api/v1/clubs/${A}/announcements`, { title: 'A', body: 'B', category: 'GENERAL', audience: 'PUBLIC', sendEmail: false }],
      ['get', `/api/v1/clubs/${A}/payments`, {}],
      ['get', `/api/v1/clubs/${A}/transactions`, {}],
      ['get', `/api/v1/clubs/${A}/inventory`, {}],
      ['get', `/api/v1/clubs/${A}/reports/finance`, {}],
    ];
    const failures = [];
    for (const [m, url, body] of cases) {
      const other = await cast.agents.CH_B[m](url).set(H).send(body);
      const sameClubVol = await cast.agents.VOL_A[m](url).set(H).send(body);
      if (other.status !== 404) failures.push(`${m.toUpperCase()} ${url} other-club head → ${other.status}`);
      if (sameClubVol.status !== 403) failures.push(`${m.toUpperCase()} ${url} same-club volunteer → ${sameClubVol.status}`);
    }
    expect(failures.join("\n")).toBe("");
  });

  it('4. no string-built SQL in src/ (no ${} interpolation or concatenation inside raw SQL)', () => {
    const files = [];
    const walk = (d) => readdirSync(d).forEach((n) => (statSync(path.join(d, n)).isDirectory() ? walk(path.join(d, n)) : n.endsWith('.js') && files.push(path.join(d, n))));
    walk(path.resolve('src'));
    const offenders = [];
    for (const f of files) {
      const s = readFileSync(f, 'utf8');
      for (const m of s.matchAll(/\.(raw|whereRaw|joinRaw|orderByRaw|havingRaw|selectRaw)\(\s*(`[^`]*`|'[^']*'\s*\+|[A-Za-z_$][\w$]*\s*[,)])/g)) {
        if (m[2].startsWith('`') && !m[2].includes('${')) continue;
        offenders.push(`${path.relative(process.cwd(), f)}: ${m[0].slice(0, 60)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('6. client prices are never trusted: expected values compared, price fields rejected', async () => {
    const buyer = await makeUser(ctx.db);
    await verifyStudent(ctx.db, buyer.id);
    const agent = await ctx.signIn(buyer.id);
    const { variants } = await makeProduct(ctx.db, cast.a, { pricePaise: 50000 });
    const order = await agent.post(`/api/v1/clubs/${cast.a.club.id}/orders`).set(H).set('Idempotency-Key', idemKey()).send({ items: [{ variantId: variants.M.id, quantity: 1 }], expectedTotalPaise: 1 });
    expect(order.status).toBe(409);
    expect(order.body.error).toMatchObject({ code: 'PRICE_CHANGED', details: { quote: { totalPaise: 50000 } } });
    const smuggled = await agent.post(`/api/v1/clubs/${cast.a.club.id}/orders`).set(H).set('Idempotency-Key', idemKey()).send({ items: [{ variantId: variants.M.id, quantity: 1, unitPricePaise: 1 }], expectedTotalPaise: 50000 });
    expect(smuggled.status).toBe(400);
    const [plan] = await ctx.db('membership_plans').insert({ club_id: cast.a.club.id, name: 'Annual', fee_paise: 50000, duration_months: 12, created_by: cast.a.head.id }).returning('*');
    const join = await agent.post(`/api/v1/clubs/${cast.a.club.id}/memberships`).set(H).set('Idempotency-Key', idemKey()).send({ planId: plan.id, expectedFeePaise: 1 });
    expect(join.status).toBe(409);
    expect(join.body.error.code).toBe('PRICE_CHANGED');
    expect(await ctx.db('payments')).toHaveLength(0);
  });

  it('unauthenticated requests to protected routes are 401 with the standard envelope', async () => {
    const res = await request(ctx.app).get('/api/v1/me/orders');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'UNAUTHENTICATED', requestId: res.headers['x-request-id'] });
  });
});
