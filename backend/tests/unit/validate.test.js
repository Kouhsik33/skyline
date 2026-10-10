import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validate } from '../../src/shared/middleware/validate.js';

// A1 — one validate() for both groups (Express 5): parsed values on req.valid for every
// controller; req.params / req.body replaced by the parsed values (Group 1 controllers read them);
// req.query is never reassigned (it is a getter in Express 5 and assigning it throws).

function appWith(schemas, handler) {
  const app = express();
  app.use(express.json());
  app.post('/things/:id', validate(schemas), handler);
  app.get('/things/:id', validate({ params: schemas.params, query: schemas.query }), handler);
  app.use((err, req, res, _next) => res.status(err.name === 'ZodError' ? 400 : 500).json({ name: err.name, message: err.message }));
  return app;
}

const schemas = {
  params: z.object({ id: z.coerce.number().int() }),
  query: z.object({ page: z.coerce.number().int().default(1), q: z.string().optional() }),
  body: z.object({ amountPaise: z.number().int() }),
};

describe('validate() (A1)', () => {
  it('query schema: parsed on req.valid.query, req.query left as the raw getter — no 500', async () => {
    let seen;
    const res = await request(
      appWith(schemas, (req, res) => {
        seen = { valid: req.valid, rawQuery: { ...req.query } };
        res.json({ ok: true });
      }),
    ).get('/things/7?page=3&q=tee');
    expect(res.status).toBe(200);
    expect(seen.valid.query).toEqual({ page: 3, q: 'tee' });
    expect(seen.valid.params).toEqual({ id: 7 });
    expect(seen.rawQuery).toEqual({ page: '3', q: 'tee' });
  });

  it('params and body: parsed values on req.valid and on req.params / req.body', async () => {
    let seen;
    const res = await request(
      appWith(schemas, (req, res) => {
        seen = { valid: req.valid, params: req.params, body: req.body };
        res.json({ ok: true });
      }),
    )
      .post('/things/9')
      .send({ amountPaise: 1500 });
    expect(res.status).toBe(200);
    expect(seen.valid).toEqual({ params: { id: 9 }, query: { page: 1 }, body: { amountPaise: 1500 } });
    expect(seen.params).toEqual({ id: 9 });
    expect(seen.body).toEqual({ amountPaise: 1500 });
  });

  it('without a query schema req.valid.query is the raw query copy; invalid input is a ZodError', async () => {
    let seen;
    const app = appWith({ params: schemas.params }, (req, res) => {
      seen = req.valid;
      res.json({ ok: true });
    });
    expect((await request(app).get('/things/1?x=y')).status).toBe(200);
    expect(seen.query).toEqual({ x: 'y' });
    expect((await request(app).get('/things/abc')).status).toBe(400);
  });
});
