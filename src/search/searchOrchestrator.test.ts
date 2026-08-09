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

  it('skips extraction when search returns nothing', async () => {
    const searxngSearch = vi.fn().mockResolvedValue([]);
    const extractDates = vi.fn();

    const runQuery = createSearchOrchestrator({ searxngSearch, extractDates });
    const events = await runQuery('nothing found query');

    expect(extractDates).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});