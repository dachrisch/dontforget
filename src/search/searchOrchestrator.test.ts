import { describe, it, expect, vi } from 'vitest';
import { createSearchOrchestrator } from './searchOrchestrator';

describe('createSearchOrchestrator', () => {
  it('searches then extracts, in order, passing through the AI cadence', async () => {
    const searxngSearch = vi.fn().mockResolvedValue([{ title: 't', url: 'u', content: 'c' }]);
    const extractDates = vi
      .fn()
      .mockResolvedValue({
        events: [{ label: 'L', startDate: '2026-01-01', endDate: '2026-01-01', sourceUrl: 'u' }],
        cadence: 'yearly',
      });

    const runQuery = createSearchOrchestrator({ searxngSearch, extractDates });
    const result = await runQuery('Auer Dult Munich');

    expect(searxngSearch).toHaveBeenCalledWith('Auer Dult Munich');
    expect(extractDates).toHaveBeenCalledWith('Auer Dult Munich', [{ title: 't', url: 'u', content: 'c' }]);
    expect(result).toEqual({
      events: [{ label: 'L', startDate: '2026-01-01', endDate: '2026-01-01', sourceUrl: 'u' }],
      cadence: 'yearly',
    });
  });

  it('deduplicates events with the same daterange from different search results, even with different labels', async () => {
    const searxngSearch = vi.fn().mockResolvedValue([
      { title: 't1', url: 'u1', content: 'c1' },
      { title: 't2', url: 'u2', content: 'c2' },
    ]);
    const extractDates = vi.fn().mockResolvedValue({
      events: [
        { label: 'Jakobidult (Auer Dult)', startDate: '2026-07-25', endDate: '2026-08-02', sourceUrl: 'https://a.example' },
        { label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-02', sourceUrl: 'https://b.example' },
        { label: 'Maidult (Auer Dult)', startDate: '2026-04-25', endDate: '2026-05-03', sourceUrl: 'https://a.example' },
      ],
      cadence: 'yearly',
    });

    const runQuery = createSearchOrchestrator({ searxngSearch, extractDates });
    const result = await runQuery('Auer Dult Munich');

    expect(result).toEqual({
      events: [
        { label: 'Jakobidult (Auer Dult)', startDate: '2026-07-25', endDate: '2026-08-02', sourceUrl: 'https://a.example' },
        { label: 'Maidult (Auer Dult)', startDate: '2026-04-25', endDate: '2026-05-03', sourceUrl: 'https://a.example' },
      ],
      cadence: 'yearly',
    });
  });

  it('skips extraction when search returns nothing', async () => {
    const searxngSearch = vi.fn().mockResolvedValue([]);
    const extractDates = vi.fn();

    const runQuery = createSearchOrchestrator({ searxngSearch, extractDates });
    const result = await runQuery('nothing found query');

    expect(extractDates).not.toHaveBeenCalled();
    expect(result).toEqual({ events: [], cadence: null });
  });
});