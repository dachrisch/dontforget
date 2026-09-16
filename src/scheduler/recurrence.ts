import type { DateWindow, RecurrenceInterval } from '../types.js';

type IntervalUnit = 'date' | 'month' | 'year';

const INTERVAL_STEP: Record<RecurrenceInterval, { amount: number; unit: IntervalUnit }> = {
  weekly: { amount: 7, unit: 'date' },
  monthly: { amount: 1, unit: 'month' },
  quarterly: { amount: 3, unit: 'month' },
  yearly: { amount: 1, unit: 'year' },
};

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

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

// The window a date lookup may return: from today through the end of the
// next cadence period ("this cadence and next"). Dates before today are
// stale, and dates beyond the next period are not a plausible occurrence of
// the series yet — bounding the window keeps the model from dredging up
// long-past editions or speculative dates years out.
export function plausibleDateWindow(interval: RecurrenceInterval, now: Date = new Date()): DateWindow {
  const from = new Date(now);
  const to = new Date(now);
  const { amount, unit } = INTERVAL_STEP[interval];
  const doubled = amount * 2;
  if (unit === 'date') to.setUTCDate(to.getUTCDate() + doubled);
  else if (unit === 'month') to.setUTCMonth(to.getUTCMonth() + doubled);
  else to.setUTCFullYear(to.getUTCFullYear() + doubled);
  return { from: isoDate(from), to: isoDate(to) };
}

// Series expansions are bounded by the LONGER of the query's check-again
// cadence and the series' own judged cadence (issue #199). A weekly-polled
// annual festival must still look a year+ ahead, or its date is outside the
// window on every run and the series sits at "No dates yet" for months.
//
// Before a cadence has been learned (null/undefined) we default to the
// WIDEST window (yearly, issue #209) — not the query interval. The narrow
// fallback created a stuck loop: with a 14-day window the prompt instructs
// the model to omit the real (e.g. annual) date and the orchestrator drops
// it again via filterByWindow, so the run yields events:[] — and an empty
// run typically also yields cadence:null (zero searxng hits skip the LLM
// entirely), which leaves the cadence unlearned and the window narrow on
// the next run too. An unknown cadence must not narrow the lookup; once the
// first wide run judges and persists a cadence via completeSeriesExpansion,
// later runs size down to the longer of the two known cadences.
const INTERVAL_RANK: Record<RecurrenceInterval, number> = {
  weekly: 0,
  monthly: 1,
  quarterly: 2,
  yearly: 3,
};

export function plausibleDateWindowForSeries(
  queryInterval: RecurrenceInterval,
  seriesCadence?: RecurrenceInterval | null,
  now: Date = new Date()
): DateWindow {
  if (!seriesCadence) return plausibleDateWindow('yearly', now);
  const wider =
    INTERVAL_RANK[seriesCadence] >= INTERVAL_RANK[queryInterval] ? seriesCadence : queryInterval;
  return plausibleDateWindow(wider, now);
}
