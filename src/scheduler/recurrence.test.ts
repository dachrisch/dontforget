import { describe, it, expect } from 'vitest';
import { nextRunAt, isDue } from './recurrence';

describe('nextRunAt', () => {
  it('adds 7 days for weekly', () => {
    expect(nextRunAt(new Date('2026-08-01T00:00:00Z'), 'weekly')).toEqual(new Date('2026-08-08T00:00:00Z'));
  });

  it('adds 1 calendar month for monthly', () => {
    expect(nextRunAt(new Date('2026-08-01T00:00:00Z'), 'monthly')).toEqual(new Date('2026-09-01T00:00:00Z'));
  });

  it('adds 3 calendar months for quarterly', () => {
    expect(nextRunAt(new Date('2026-01-15T00:00:00Z'), 'quarterly')).toEqual(new Date('2026-04-15T00:00:00Z'));
  });

  it('adds 1 calendar year for yearly', () => {
    expect(nextRunAt(new Date('2026-08-01T00:00:00Z'), 'yearly')).toEqual(new Date('2027-08-01T00:00:00Z'));
  });

  it('rolls over into the following month when the day does not exist there (native Date behavior)', () => {
    // Jan 31 + 1 month: February 2026 only has 28 days, so this lands on
    // March 3rd, not February 28th or 31st. Documented, not "fixed" —
    // last_run_at inherits the rolled-over date, so the next cycle repeats
    // from March 3rd rather than drifting further.
    expect(nextRunAt(new Date('2026-01-31T00:00:00Z'), 'monthly')).toEqual(new Date('2026-03-03T00:00:00Z'));
  });
});

describe('isDue', () => {
  it('is not due one day before the interval elapses', () => {
    const lastRunAt = new Date('2026-08-01T00:00:00Z');
    const now = new Date('2026-08-07T00:00:00Z');
    expect(isDue(lastRunAt, 'weekly', now)).toBe(false);
  });

  it('is due exactly when the interval elapses', () => {
    const lastRunAt = new Date('2026-08-01T00:00:00Z');
    const now = new Date('2026-08-08T00:00:00Z');
    expect(isDue(lastRunAt, 'weekly', now)).toBe(true);
  });

  it('is due well after the interval elapses', () => {
    const lastRunAt = new Date('2026-01-01T00:00:00Z');
    const now = new Date('2026-08-01T00:00:00Z');
    expect(isDue(lastRunAt, 'monthly', now)).toBe(true);
  });
});
