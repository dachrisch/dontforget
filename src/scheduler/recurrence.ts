import type { RecurrenceInterval } from '../types.js';

type IntervalUnit = 'date' | 'month' | 'year';

const INTERVAL_STEP: Record<RecurrenceInterval, { amount: number; unit: IntervalUnit }> = {
  weekly: { amount: 7, unit: 'date' },
  monthly: { amount: 1, unit: 'month' },
  quarterly: { amount: 3, unit: 'month' },
  yearly: { amount: 1, unit: 'year' },
};

// last_run_at is a MongoDB BSON Date (a UTC instant, no embedded timezone),
// so we use the setUTC* variants, not local-time setDate/setMonth/setFullYear:
// local-time methods would make results depend on the server's TZ and drift
// an hour whenever an interval spans a DST transition (reproduced empirically
// during implementation — see docs/superpowers/specs/2026-08-14-scheduler-design.md).
export function nextRunAt(lastRunAt: Date, interval: RecurrenceInterval): Date {
  const next = new Date(lastRunAt);
  const { amount, unit } = INTERVAL_STEP[interval];
  if (unit === 'date') next.setUTCDate(next.getUTCDate() + amount);
  else if (unit === 'month') next.setUTCMonth(next.getUTCMonth() + amount);
  else next.setUTCFullYear(next.getUTCFullYear() + amount);
  return next;
}

export function isDue(lastRunAt: Date, interval: RecurrenceInterval, now: Date): boolean {
  return nextRunAt(lastRunAt, interval).getTime() <= now.getTime();
}
