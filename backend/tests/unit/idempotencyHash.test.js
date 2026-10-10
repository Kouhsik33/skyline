import { describe, expect, it } from 'vitest';
import { requestHash } from '../../src/shared/middleware/idempotencyG2.js';

describe('idempotency request hash', () => {
  it('is stable under key order and differs on method, path or body', () => {
    const a = requestHash('POST', '/api/v1/payments/x/simulate', { outcome: 'SUCCEEDED', n: { b: 1, a: 2 } });
    expect(requestHash('POST', '/api/v1/payments/x/simulate', { n: { a: 2, b: 1 }, outcome: 'SUCCEEDED' })).toBe(a);
    expect(requestHash('POST', '/api/v1/payments/x/simulate', { outcome: 'FAILED', n: { a: 2, b: 1 } })).not.toBe(a);
    expect(requestHash('POST', '/api/v1/payments/y/simulate', { outcome: 'SUCCEEDED', n: { a: 2, b: 1 } })).not.toBe(a);
    expect(requestHash('PUT', '/api/v1/payments/x/simulate', { outcome: 'SUCCEEDED', n: { a: 2, b: 1 } })).not.toBe(a);
  });
});
