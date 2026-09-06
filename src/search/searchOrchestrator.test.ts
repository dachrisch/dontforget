import { describe, it, expect, vi } from 'vitest';
import { createSearchOrchestrator, createSeriesDiscoveryOrchestrator } from './searchOrchestrator';
import { MAX_SERIES } from './opencodeClient';

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

describe('createSeriesDiscoveryOrchestrator', () => {
  function seriesFixture(n: number, prefix = 'Series') {
    return Array.from({ length: n }, (_, i) => ({
      title: `${prefix} ${i + 1}`,
      description: `desc ${i + 1}`,
      searchKeywords: `${prefix} ${i + 1} Munich dates`,
      sourceUrls: [`https://example.com/${i + 1}`],
    }));
  }

  it('issues exactly 1 searxng call + 1 extractSeries call for a broad query', async () => {
    const searxngSearch = vi.fn().mockResolvedValue([{ title: 't', url: 'u', content: 'c' }]);
    const extractSeries = vi.fn().mockResolvedValue({ series: seriesFixture(4) });

    const discover = createSeriesDiscoveryOrchestrator({ searxngSearch, extractSeries });
    const result = await discover('events in munich');

    expect(searxngSearch).toHaveBeenCalledTimes(1);
    expect(searxngSearch).toHaveBeenCalledWith('events in munich');
    expect(extractSeries).toHaveBeenCalledTimes(1);
    expect(extractSeries).toHaveBeenCalledWith('events in munich', [{ title: 't', url: 'u', content: 'c' }]);
    expect(result.series).toHaveLength(4);
    for (const s of result.series) {
      expect(s.title).toBeTruthy();
      expect(s.searchKeywords).toBeTruthy();
      expect(s.sourceUrls.length).toBeGreaterThan(0);
    }
  });

  it('caps discovery at MAX_SERIES, truncating deterministically in model order', async () => {
    const searxngSearch = vi.fn().mockResolvedValue([{ title: 't', url: 'u', content: 'c' }]);
    const extractSeries = vi.fn().mockResolvedValue({ series: seriesFixture(MAX_SERIES + 8) });

    const discover = createSeriesDiscoveryOrchestrator({ searxngSearch, extractSeries });
    const result = await discover('events in munich');

    expect(MAX_SERIES).toBe(12);
    expect(result.series).toHaveLength(MAX_SERIES);
    // First N in model order win.
    expect(result.series[0].title).toBe('Series 1');
    expect(result.series[MAX_SERIES - 1].title).toBe(`Series ${MAX_SERIES}`);
  });

  it('dedupes series by normalized title, first occurrence wins', async () => {
    const searxngSearch = vi.fn().mockResolvedValue([{ title: 't', url: 'u', content: 'c' }]);
    const extractSeries = vi.fn().mockResolvedValue({
      series: [
        { title: 'Oktoberfest', description: 'd', searchKeywords: 'Oktoberfest Munich', sourceUrls: ['https://a.example'] },
        { title: '  OKTOBERFEST ', description: 'dup', searchKeywords: 'Oktoberfest dup', sourceUrls: ['https://b.example'] },
        { title: 'Auer Dult', description: 'd', searchKeywords: 'Auer Dult Munich', sourceUrls: ['https://c.example'] },
      ],
    });

    const discover = createSeriesDiscoveryOrchestrator({ searxngSearch, extractSeries });
    const result = await discover('events in munich');

    expect(result.series.map(s => s.title)).toEqual(['Oktoberfest', 'Auer Dult']);
  });

  it('resolves a narrow query to exactly 1 series (degenerate case)', async () => {
    const searxngSearch = vi.fn().mockResolvedValue([{ title: 't', url: 'u', content: 'c' }]);
    const extractSeries = vi.fn().mockResolvedValue({
      series: [
        { title: 'Auer Dult', description: 'Munich fair', searchKeywords: 'Auer Dult Munich dates', sourceUrls: ['https://auerdult.de'] },
      ],
    });

    const discover = createSeriesDiscoveryOrchestrator({ searxngSearch, extractSeries });
    const result = await discover('Auer Dult Munich');

    expect(result.series).toHaveLength(1);
    expect(result.series[0]).toMatchObject({ title: 'Auer Dult', searchKeywords: 'Auer Dult Munich dates' });
  });

  it('skips extraction when the probe returns nothing', async () => {
    const searxngSearch = vi.fn().mockResolvedValue([]);
    const extractSeries = vi.fn();

    const discover = createSeriesDiscoveryOrchestrator({ searxngSearch, extractSeries });
    const result = await discover('nothing found query');

    expect(extractSeries).not.toHaveBeenCalled();
    expect(result).toEqual({ series: [] });
  });
});