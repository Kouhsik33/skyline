import { describe, expect, it } from 'vitest';
import { applyBps, assertPositivePaise, format, multiply, sum, sumPaise } from '../../src/shared/money.js';

describe('money (ADR-008)', () => {
  it('applyBps rounds half-up to the paise: floor((p*bps+5000)/10000)', () => {
    expect(applyBps(20000, 1000)).toBe(2000); // TC-PRC-01 shape: 10% of ₹200
    expect(applyBps(15, 3333)).toBe(5); // 4.9995 -> 5
    expect(applyBps(1, 5000)).toBe(1); // 0.5 -> 1 (half-up)
    expect(applyBps(1, 4999)).toBe(0);
    expect(applyBps(99999, 10000)).toBe(99999);
    expect(applyBps(12345, 0)).toBe(0);
  });

  it('stays exact near Number.MAX_SAFE_INTEGER (BigInt inside)', () => {
    const p = Number.MAX_SAFE_INTEGER - 1;
    expect(applyBps(p, 10000)).toBe(p);
  });

  it('rejects non-integer money and out-of-range bps', () => {
    expect(() => applyBps(10.5, 100)).toThrow(TypeError);
    expect(() => applyBps(100, 10001)).toThrow(RangeError);
    expect(() => applyBps(100, 1.5)).toThrow(RangeError);
    expect(() => applyBps(-1, 100)).toThrow(RangeError);
    expect(() => assertPositivePaise(0)).toThrow(RangeError);
    expect(() => assertPositivePaise('100')).toThrow(TypeError);
  });

  it('sum and multiply are integer-only and overflow-checked', () => {
    expect(sum([100, 250, 1])).toBe(351);
    expect(sum([])).toBe(0);
    expect(sumPaise([100, 250, 1])).toBe(351); // Group 1 name, same integer-only implementation
    expect(multiply(1999, 3)).toBe(5997);
    expect(() => sum([0.1, 0.2])).toThrow(TypeError);
    expect(() => multiply(Number.MAX_SAFE_INTEGER, 2)).toThrow(RangeError);
  });

  it('formats INR with Indian grouping', () => {
    expect(format(123450)).toBe('₹1,234.50');
    expect(format(5)).toBe('₹0.05');
    expect(format(1234567890)).toBe('₹1,23,45,678.90');
    expect(format(-50000)).toBe('-₹500.00');
  });
});
