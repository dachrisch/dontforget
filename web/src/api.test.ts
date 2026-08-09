import { describe, it, expect, vi, afterEach } from 'vitest';
import { requestMagicLink, checkSession, submitQuery, approveEvents, ApiError } from './api';

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

  it('approveEvents throws ApiError on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'nope' }));

    await expect(approveEvents('q1', ['e1'])).rejects.toBeInstanceOf(ApiError);
  });
});