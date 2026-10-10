import { Writable } from 'node:stream';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildTestContext } from '../helpers/testApp.js';
import { createLogger } from '../../src/shared/logger.js';
import { appError } from '../../src/shared/errors.js';
import { logger as appLogger } from '../../src/shared/logger.js';
import { vi } from 'vitest';
import { validate } from '../../src/shared/middleware/validate.js';

// T-12 acceptance: every error returns { error: { code, message, details, requestId } } with the
// request id; no stack traces in responses; logs are redacted.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('error envelope, request id, security headers', () => {
  let ctx;
  const logLines = [];
  beforeAll(() => {
    const stream = new Writable({
      write(chunk, enc, cb) {
        logLines.push(chunk.toString());
        cb();
      },
    });
    ctx = buildTestContext({
      logger: createLogger({ level: 'info', destination: stream }),
      extraRoutes(router) {
        router.get('/__test/boom', () => {
          throw new Error('secret internal detail at /app/src/x.js');
        });
        router.get('/__test/conflict', () => {
          throw appError('CONFLICT_STATE', { currentStatus: 'SUCCEEDED' });
        });
        router.post('/__test/echo', validate({ body: z.object({ amountPaise: z.number().int() }).strict() }), (req, res) =>
          res.json({ data: req.valid.body }),
        );
      },
    });
  });
  afterAll(() => ctx.close());

  const expectEnvelope = (res, status, code) => {
    expect(res.status).toBe(status);
    expect(Object.keys(res.body)).toEqual(['error']);
    expect(Object.keys(res.body.error).sort()).toEqual(['code', 'details', 'message', 'requestId']);
    expect(res.body.error.code).toBe(code);
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
    expect(JSON.stringify(res.body)).not.toMatch(/at \/|\.js:\d+|stack/);
  };

  it('unknown route → 404 NOT_FOUND with a generated request id', async () => {
    const res = await request(ctx.app).get('/api/v1/nope');
    expectEnvelope(res, 404, 'NOT_FOUND');
    expect(res.body.error.requestId).toMatch(UUID);
  });

  it('accepts a UUID X-Request-Id from the client, ignores anything else', async () => {
    const id = crypto.randomUUID();
    expect((await request(ctx.app).get('/api/v1/nope').set('X-Request-Id', id)).body.error.requestId).toBe(id);
    const res = await request(ctx.app).get('/api/v1/nope').set('X-Request-Id', '<script>');
    expect(res.body.error.requestId).toMatch(UUID);
  });

  it('unexpected error → 500 INTERNAL_ERROR, safe message, stack logged not sent', async () => {
    const spy = vi.spyOn(appLogger, 'error');
    const res = await request(ctx.app).get('/api/v1/__test/boom');
    expectEnvelope(res, 500, 'INTERNAL_ERROR');
    expect(res.body.error.message).not.toContain('secret internal detail');
    expect(spy.mock.calls.some(([o]) => String(o?.err?.stack ?? '').includes('secret internal detail'))).toBe(true);
    spy.mockRestore();
  });

  it('AppError keeps its code and details', async () => {
    const res = await request(ctx.app).get('/api/v1/__test/conflict');
    expectEnvelope(res, 409, 'CONFLICT_STATE');
    expect(res.body.error.details).toEqual({ currentStatus: 'SUCCEEDED' });
  });

  it('zod failure → 400 VALIDATION_FAILED with details.fields; malformed JSON likewise', async () => {
    const bad = await request(ctx.app).post('/api/v1/__test/echo').set('X-Requested-With', 'soms').send({ amountPaise: 10.5 });
    expectEnvelope(bad, 400, 'VALIDATION_FAILED');
    expect(bad.body.error.details.fields[0].path).toBe('amountPaise');

    const malformed = await request(ctx.app)
      .post('/api/v1/__test/echo')
      .set('X-Requested-With', 'soms')
      .set('Content-Type', 'application/json')
      .send('{"amountPaise": ');
    expectEnvelope(malformed, 400, 'VALIDATION_FAILED');
  });

  it('mutating request without X-Requested-With: soms → 403 FORBIDDEN', async () => {
    const res = await request(ctx.app).post('/api/v1/__test/echo').send({ amountPaise: 1 });
    expectEnvelope(res, 403, 'FORBIDDEN');
    expect(res.body.error.details).toEqual({ reason: 'CSRF_HEADER_MISSING' });
  });

  it('protected route without a session → 401 UNAUTHENTICATED', async () => {
    expectEnvelope(await request(ctx.app).get('/api/v1/me/payments'), 401, 'UNAUTHENTICATED');
  });

  it('helmet headers are set; x-powered-by is not', async () => {
    const res = await request(ctx.app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: 'ok', db: 'ok' } }); // merged health shape (Group 1)
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeTruthy();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('request logs never contain the session cookie, and never bodies', async () => {
    logLines.length = 0;
    const user = await ctx.db('users')
      .insert({ email: `log-${Date.now()}@example.test`, full_name: 'Log Test', password_hash: 'x', phone_e164: '+919876543210' })
      .returning('*')
      .then((r) => r[0]);
    const agent = request.agent(ctx.app);
    const signIn = await agent.post('/api/v1/__test/sign-in').set('X-Requested-With', 'soms').send({ userId: user.id }).expect(204);
    const sid = /^sid=([^;]+)/.exec(signIn.headers['set-cookie'][0])[1];
    const rawSessionId = decodeURIComponent(sid).slice(2).split('.')[0];
    await agent.get('/api/v1/me/payments').expect(200);
    await agent.post('/api/v1/__test/echo').set('X-Requested-With', 'soms').send({ amountPaise: 777123 }).expect(200);
    const out = logLines.join('');
    expect(out).toContain('"url":"/api/v1/me/payments"'); // pino-http request log
    expect(out).toContain(`"userId":"${user.id}"`);
    expect(out).not.toContain(sid);
    expect(out).not.toContain(rawSessionId);
    expect(out).not.toContain('777123');
    expect(out).not.toContain('+919876543210');
    await ctx.db('users').where({ id: user.id }).del();
  });
});
