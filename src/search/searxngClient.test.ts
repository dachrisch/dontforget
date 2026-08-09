import { describe, it, expect, vi, afterEach } from 'vitest';
import { searxngSearch } from './searxngClient';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('searxngSearch', () => {
  it('parses results from the JSON API', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        query: 'Auer Dult Munich',
        results: [{ title: 'Auer Dult', url: 'https://auerdult.de', content: 'Spring fair dates' }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await searxngSearch('https://search.lehel.xyz', 'Auer Dult Munich');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://search.lehel.xyz/search?q=Auer%20Dult%20Munich&format=json'
    );
    expect(results).toEqual([
      { title: 'Auer Dult', url: 'https://auerdult.de', content: 'Spring fair dates' },
    ]);
  });

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(searxngSearch('https://search.lehel.xyz', 'x')).rejects.toThrow('503');
  });
});