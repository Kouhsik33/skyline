import { describe, expect, it } from 'vitest';
import { createHandlerRegistry, withBothCases } from '../../src/modules/finance/payments/handlerRegistry.js';

const handler = (purpose, seen = []) => ({
  purpose,
  onSucceeded: async (p) => seen.push(['ok', p]),
  onFailed: async (p, reason) => seen.push(['fail', p, reason]),
});

describe('payment handler registry (LLD §2.10) — one registry for both engines', () => {
  it('registers one handler per purpose and dispatches to it', async () => {
    const r = createHandlerRegistry();
    const seen = [];
    r.register(handler('EVENT_TICKET', seen));
    expect(r.purposes()).toEqual(['EVENT_TICKET']);
    await r.get('EVENT_TICKET').onSucceeded({ id: 'p1', club_id: 'c1', amount_paise: 100 });
    expect(seen[0][0]).toBe('ok');
  });

  it('rejects duplicates, unknown purposes and incomplete handlers', () => {
    const r = createHandlerRegistry();
    r.register(handler('MERCH_ORDER'));
    expect(() => r.register(handler('MERCH_ORDER'))).toThrow(/already registered/);
    expect(() => r.register(handler('DONATION'))).toThrow(/unknown purpose/);
    expect(() => r.register({ purpose: 'EVENT_TICKET', onSucceeded: async () => null })).toThrow(/onFailed/);
  });

  it('an unregistered purpose is a programming error (500), not a client error', () => {
    expect(() => createHandlerRegistry().get('MEMBERSHIP_JOIN')).toThrow(/no payment handler/);
  });

  it('handlers receive both row styles: Group 1 reads camelCase, Group 2 snake_case', async () => {
    const r = createHandlerRegistry();
    const seen = [];
    r.register(handler('MERCH_ORDER', seen));
    const settledAt = new Date('2026-11-01T00:00:00Z');
    await r.get('MERCH_ORDER').onSucceeded({ id: 'p1', clubId: 'c1', amountPaise: 900, orderId: 'o1', settledAt });
    await r.get('MERCH_ORDER').onFailed({ id: 'p2', club_id: 'c1', amount_paise: 500, order_id: 'o2' }, 'EXPIRED');
    expect(seen[0][1]).toMatchObject({ club_id: 'c1', clubId: 'c1', amount_paise: 900, amountPaise: 900, order_id: 'o1', orderId: 'o1', settled_at: settledAt });
    expect(seen[1][1]).toMatchObject({ club_id: 'c1', clubId: 'c1', amount_paise: 500, amountPaise: 500, order_id: 'o2', orderId: 'o2' });
    expect(seen[1][2]).toBe('EXPIRED');
    expect(withBothCases(null)).toBeNull();
  });
});
