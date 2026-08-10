import { describe, it, expect, vi } from 'vitest';
import { createSearchOrchestrator } from './searchOrchestrator';

describe('createSearchOrchestrator', () => {
  it('searches then extracts, in order', async () => {
    const searxngSearch = vi.fn().mockResolvedValue([{ title: 't', url: 'u', content: 'c' }]);
    const extractDates = vi
      .fn()
      .mockResolvedValue([{ label: 'L', startDate: '2026-01-01', endDate: '2026-01-01', sourceUrl: 'u' }]);

    const runQuery = createSearchOrchestrator({ searxngSearch, extractDates });
    const events = await runQuery('Auer Dult Munich');

    expect(searxngSearch).toHaveBeenCalledWith('Auer Dult Munich');
    expect(extractDates).toHaveBeenCalledWith('Auer Dult Munich', [{ title: 't', url: 'u', content: 'c' }]);
    expect(events).toEqual([{ label: 'L', startDate: '2026-01-01', endDate: '2026-01-01', sourceUrl: 'u' }]);
  });

  it('deduplicates events with the same label and dates from different search results', async () => {
    const searxngSearch = vi.fn().mockResolvedValue([
      { title: 't1', url: 'u1', content: 'c1' },
      { title: 't2', url: 'u2', content: 'c2' },
    ]);
    const extractDates = vi.fn().mockResolvedValue([
      { label: 'Jakobidult (Auer Dult)', startDate: '2026-07-25', endDate: '2026-08-02', sourceUrl: 'https://a.example' },
      { label: 'Jakobidult (Auer Dult)', startDate: '2026-07-25', endDate: '2026-08-02', sourceUrl: 'https://b.example' },
      { label: 'Maidult (Auer Dult)', startDate: '2026-04-25', endDate: '2026-05-03', sourceUrl: 'https://a.example' },
    ]);

    const runQuery = createSearchOrchestrator({ searxngSearch, extractDates });
    const events = await runQuery('Auer Dult Munich');

    expect(events).toEqual([
      { label: 'Jakobidult (Auer Dult)', startDate: '2026-07-25', endDate: '2026-08-02', sourceUrl: 'https://a.example' },
      { label: 'Maidult (Auer Dult)', startDate: '2026-04-25', endDate: '2026-05-03', sourceUrl: 'https://a.example' },
    ]);
  });

  it('skips extraction when search returns nothing', async () => {
    const searxngSearch = vi.fn().mockResolvedValue([]);
    const extractDates = vi.fn();

    const runQuery = createSearchOrchestrator({ searxngSearch, extractDates });
    const events = await runQuery('nothing found query');

    expect(extractDates).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});