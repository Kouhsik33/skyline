import { config } from '../config/index.js';

let overrideNow = null;

export function setClock(now) {
  overrideNow = now instanceof Date ? now : now ? new Date(now) : null;
}

export function resetClock() {
  overrideNow = null;
}

export function now() {
  return overrideNow ? new Date(overrideNow) : new Date();
}

/** Today as YYYY-MM-DD in APP_TIMEZONE (IST). */
export function todayIST() {
  const d = now();
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export function addMonthsToDate(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCMonth(dt.getUTCMonth() + months);
  return dt.toISOString().slice(0, 10);
}

/** endsOn = addMonths(startsOn, durationMonths) - 1 day */
export function computeTermEndsOn(startsOn, durationMonths) {
  const endExclusive = addMonthsToDate(startsOn, durationMonths);
  const [y, m, d] = endExclusive.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

export function addDaysToDate(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** YYYY-MM-DD of an instant in a time zone (job run keys, LLD §7). */
export function isoDateInZone(instant, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}
