import { describe, it, expect } from 'vitest';
import { filterNewEvents } from './dedupeEvents';

describe('filterNewEvents', () => {
  it('drops a candidate matching an existing event on label, start, and end date', () => {
    const candidates = [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://a.example' },
    ];
    const existing = [{ label: 'Frühjahrsdult', start_date: '2026-04-11', end_date: '2026-05-11' }];

    expect(filterNewEvents(candidates, existing)).toEqual([]);
  });

  it('keeps a candidate that differs in any of label, start date, or end date', () => {
    const candidates = [
      { label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'https://a.example' },
    ];
    const existing = [{ label: 'Jakobidult', start_date: '2026-07-24', end_date: '2026-08-03' }];

    expect(filterNewEvents(candidates, existing)).toEqual(candidates);
  });

  it('returns every candidate unchanged when nothing exists yet', () => {
    const candidates = [
      { label: 'Oktoberfest', startDate: '2026-09-19', endDate: '2026-10-04', sourceUrl: 'https://a.example' },
    ];
    expect(filterNewEvents(candidates, [])).toEqual(candidates);
  });

  it('ignores source URL when matching, so the same event from a different page still dedups', () => {
    const candidates = [
      { label: 'Oktoberfest', startDate: '2026-09-19', endDate: '2026-10-04', sourceUrl: 'https://different-page.example' },
    ];
    const existing = [{ label: 'Oktoberfest', start_date: '2026-09-19', end_date: '2026-10-04' }];

    expect(filterNewEvents(candidates, existing)).toEqual([]);
  });
});
