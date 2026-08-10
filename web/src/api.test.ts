import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  requestMagicLink,
  checkSession,
  submitQuery,
  approveEvents,
  listQueries,
  updateQuery,
  ApiError,
} from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api client', () => {
  it('requestMagicLink posts the email', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await requestMagicLink('a@example.com');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/magic-link',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ email: 'a@example.com' }) })
    );
  });

  it('checkSession returns true only on a 2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    expect(await checkSession()).toBe(true);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    expect(await checkSession()).toBe(false);
  });

  it('submitQuery parses the JSON body on success', async () => {
    const body = { queryId: 'q1', candidates: [] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }));

    expect(await submitQuery('Auer Dult Munich')).toEqual(body);
  });

  it('submitQuery sends the chosen recurrence interval', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ queryId: 'q1', candidates: [] }) });
    vi.stubGlobal('fetch', fetchMock);

    await submitQuery('Auer Dult Munich', 'quarterly');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/queries',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'Auer Dult Munich', recurrenceInterval: 'quarterly' }) })
    );
  });

  it('listQueries parses the dashboard payload', async () => {
    const body = {
      queries: [{ id: 'q1', text: 'Auer Dult Munich', recurrenceInterval: 'monthly', lastRunAt: null, createdAt: '2026-08-10T00:00:00Z', approvedCount: 2, candidateCount: 0 }],
      feed: { icsUrl: 'https://x/f/t.ics', rssUrl: 'https://x/f/t.rss', lastFetchedAt: null },
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal('fetch', fetchMock);

    expect(await listQueries()).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith('/api/queries', { credentials: 'include' });
  });

  it('updateQuery PATCHes the query', async () => {
    const body = { id: 'q1', text: 'Auer Dult', recurrenceInterval: 'weekly', lastRunAt: null, createdAt: '2026-08-10T00:00:00Z', approvedCount: 0, candidateCount: 0 };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal('fetch', fetchMock);

    await updateQuery('q1', { text: 'Auer Dult', recurrenceInterval: 'weekly' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/queries/q1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ text: 'Auer Dult', recurrenceInterval: 'weekly' }),
      })
    );
  });

  it('approveEvents throws ApiError on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'nope' }));

    await expect(approveEvents('q1', ['e1'])).rejects.toBeInstanceOf(ApiError);
  });
});