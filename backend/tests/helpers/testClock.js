import { isoDateInZone, resetClock, setClock } from '../../src/shared/clock.js';

// testClock.set('2026-11-01T10:00:00+05:30'); testClock.advance({ minutes: 16 }) (LLD §10).
// Drives the shared clock (setClock), so Group 1 and Group 2 code see the same time.
export function createTestClock(initial = '2026-11-01T10:00:00+05:30', timeZone = 'Asia/Kolkata') {
  let current = new Date(initial);
  setClock(current);
  return {
    now: () => new Date(current.getTime()),
    todayIST: () => isoDateInZone(current, timeZone),
    timeZone,
    set(value) {
      current = new Date(value);
      setClock(current);
    },
    advance({ minutes = 0, hours = 0, days = 0 } = {}) {
      current = new Date(current.getTime() + ((days * 24 + hours) * 60 + minutes) * 60_000);
      setClock(current);
    },
    reset() {
      resetClock();
    },
  };
}
