import { describe, it, expect } from 'vitest';
import { filterNewEvents } from './dedupeEvents';

describe('filterNewEvents', () => {
  it('drops a candidate whose daterange matches an existing event, even with a different label', () => {
    const candidates = [
      { label: 'Frühjahrsdult (Auer Dult)', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://a.example' },
    ];
    const existing = [{ start_date: '2026-04-11', end_date: '2026-05-11' }];

    expect(filterNewEvents(candidates, existing)).toEqual([]);
  });

  it('keeps a candidate whose daterange differs from every existing event', () => {
    const candidates = [
      { label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'https://a.example' },
    ];
    const existing = [{ start_date: '2026-07-24', end_date: '2026-08-03' }];

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
    const existing = [{ start_date: '2026-09-19', end_date: '2026-10-04' }];

    expect(filterNewEvents(candidates, existing)).toEqual([]);
  });

  it('collapses duplicates within a single candidate batch, keeping the first occurrence', () => {
    const candidates = [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://a.example' },
      { label: 'Frühjahrsdult (Auer Dult)', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://b.example' },
      { label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'https://a.example' },
    ];

    expect(filterNewEvents(candidates, [])).toEqual([candidates[0], candidates[2]]);
  });
});