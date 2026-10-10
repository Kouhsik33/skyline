// Money helpers (ADR-008). Integer paise only; percentages are basis points.
// No floating-point arithmetic: products go through BigInt.

const MAX = BigInt(Number.MAX_SAFE_INTEGER);

export function isPaise(value) {
  return Number.isSafeInteger(value);
}

export function assertPaise(value, name = 'amount') {
  if (!isPaise(value)) throw new TypeError(`${name} must be a safe integer number of paise`);
  return value;
}

export function assertPositivePaise(value, name = 'amount') {
  assertPaise(value, name);
  if (value <= 0) throw new RangeError(`${name} must be greater than 0`);
  return value;
}

export function assertBps(bps) {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) throw new RangeError('bps must be an integer 0–10000');
  return bps;
}

function toSafeNumber(big) {
  if (big > MAX || big < -MAX) throw new RangeError('money overflow');
  return Number(big);
}

/** discount(p, bps) = floor((p * bps + 5000) / 10000) — half-up to the paise (LLD §2.6). */
export function applyBps(paise, bps) {
  assertPaise(paise, 'paise');
  assertBps(bps);
  if (paise < 0) throw new RangeError('paise must be >= 0');
  return toSafeNumber((BigInt(paise) * BigInt(bps) + 5000n) / 10000n);
}

export function sum(values) {
  let total = 0n;
  for (const v of values) total += BigInt(assertPaise(v));
  return toSafeNumber(total);
}

export function multiply(paise, quantity) {
  assertPaise(paise, 'paise');
  if (!Number.isSafeInteger(quantity)) throw new TypeError('quantity must be an integer');
  return toSafeNumber(BigInt(paise) * BigInt(quantity));
}

/** format(123450) -> "₹1,234.50" (Indian digit grouping). */
export function format(paise) {
  assertPaise(paise);
  const negative = paise < 0;
  const abs = BigInt(Math.abs(paise));
  const rupees = (abs / 100n).toString();
  const fraction = (abs % 100n).toString().padStart(2, '0');
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${negative ? '-' : ''}₹${grouped}.${fraction}`;
}

/** Group 1 name for sum() (integer paise only). */
export const sumPaise = sum;
