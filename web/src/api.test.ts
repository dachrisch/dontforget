import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  requestMagicLink,
  getMe,
  submitQuery,
  approveEvents,
  listQueries,
  updateQuery,
  getQueryEvents,
  deleteQuery,
  runQuery,
  signOut,
  deleteAccount,
  getAdminStats,
  listAdminUsers,
  deleteAdminUser,
  getBillingStatus,
  listAdminModels,
  addAdminModel,
  updateAdminModel,
  getAdminSearch,
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

  it('getMe returns the session role on a 2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ authenticated: true, role: 'admin' }) }));
    expect(await getMe()).toEqual({ authenticated: true, role: 'admin' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    expect(await getMe()).toEqual({ authenticated: false, role: 'user' });
  });

  it('submitQuery parses the JSON body on success', async () => {
    const body = { queryId: 'q1' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }));

    expect(await submitQuery('Auer Dult Munich')).toEqual(body);
  });

  it('submitQuery sends the chosen recurrence interval', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ queryId: 'q1' }) });
    vi.stubGlobal('fetch', fetchMock);

    await submitQuery('Auer Dult Munich', 'quarterly');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/queries',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'Auer Dult Munich', recurrenceInterval: 'quarterly' }) })
    );
  });

  it('runQuery posts to the query run endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ queryId: 'q1' }) });
    vi.stubGlobal('fetch', fetchMock);

    await runQuery('q1');

    expect(fetchMock).toHaveBeenCalledWith('/api/queries/q1/run', {
      method: 'POST',
      credentials: 'include',
    });
  });

  it('listQueries parses the dashboard payload', async () => {
    const body = {
      queries: [{ id: 'q1', text: 'Auer Dult Munich', recurrenceInterval: 'monthly', lastRunAt: null, createdAt: '2026-08-10T00:00:00Z', approvedCount: 2, candidateCount: 0, status: 'ready' }],
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

  it('approveEvents sends the chosen cadence alongside the event ids', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ icsUrl: 'https://x/f/t.ics', rssUrl: 'https://x/f/t.rss' }) });
    vi.stubGlobal('fetch', fetchMock);

    await approveEvents('q1', ['e1'], 'yearly');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/queries/q1/approve',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ eventIds: ['e1'], recurrenceInterval: 'yearly' }),
      })
    );
  });

  it('approveEvents omits the cadence when none was chosen', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ icsUrl: 'https://x/f/t.ics', rssUrl: 'https://x/f/t.rss' }) });
    vi.stubGlobal('fetch', fetchMock);

    await approveEvents('q1', ['e1']);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/queries/q1/approve',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ eventIds: ['e1'] }) })
    );
  });

  it('approveEvents sends dismissEventIds alongside the event ids', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ icsUrl: 'https://x/f/t.ics', rssUrl: 'https://x/f/t.rss' }) });
    vi.stubGlobal('fetch', fetchMock);

    await approveEvents('q1', ['e1'], undefined, ['e2']);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/queries/q1/approve',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ eventIds: ['e1'], dismissEventIds: ['e2'] }) })
    );
  });

  it('approveEvents throws ApiError on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'nope' }));

    await expect(approveEvents('q1', ['e1'])).rejects.toBeInstanceOf(ApiError);
  });

  it('signOut posts to the signout endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await signOut();

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/signout', {
      method: 'POST',
      credentials: 'include',
    });
  });

  it('deleteAccount sends a DELETE to the account endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await deleteAccount();

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/account', {
      method: 'DELETE',
      credentials: 'include',
    });
  });

  it('deleteAccount throws ApiError on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'nope' }));

    await expect(deleteAccount()).rejects.toBeInstanceOf(ApiError);
  });

  it('getQueryEvents fetches the events for a query', async () => {
    const body = [{ id: 'e1', label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u', status: 'approved' }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }));

    expect(await getQueryEvents('q1')).toEqual(body);
  });

  it('deleteQuery sends a DELETE and resolves on 2xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await deleteQuery('q1');

    expect(fetchMock).toHaveBeenCalledWith('/api/queries/q1', {
      method: 'DELETE',
      credentials: 'include',
    });
  });

  it('deleteQuery throws ApiError on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'nope' }));

    await expect(deleteQuery('q1')).rejects.toBeInstanceOf(ApiError);
  });

  it('getAdminStats parses the stats payload', async () => {
    const body = { totalUsers: 2, totalQueries: 5, approvedEvents: 3, candidateEvents: 1, activeUsers7d: 2 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }));

    expect(await getAdminStats()).toEqual(body);
    expect(fetch).toHaveBeenCalledWith('/api/admin/stats', { credentials: 'include' });
  });

  it('listAdminUsers parses the user list', async () => {
    const body = [{ id: 'u1', email: 'a@example.com', role: 'user', createdAt: null, queryCount: 1 }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }));

    expect(await listAdminUsers()).toEqual(body);
    expect(fetch).toHaveBeenCalledWith('/api/admin/users', { credentials: 'include' });
  });

  it('deleteAdminUser sends a DELETE and resolves on 2xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await deleteAdminUser('u1');

    expect(fetchMock).toHaveBeenCalledWith('/api/admin/users/u1', {
      method: 'DELETE',
      credentials: 'include',
    });
  });

  it('deleteAdminUser throws ApiError on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'nope' }));

    await expect(deleteAdminUser('u1')).rejects.toBeInstanceOf(ApiError);
  });

  it('getBillingStatus parses the billing status payload', async () => {
    const body = { freeLimit: 1, activeQueryCount: 0, pricePerExtraQuery: 0.5, subscribed: false, subscriptionStatus: null, checkoutUrl: '/api/billing/checkout', portalUrl: '/api/billing/portal' };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getBillingStatus()).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith('/api/billing/status', { credentials: 'include' });
  });

  it('listAdminModels parses the model list', async () => {
    const body = [
      {
        id: 'deepseek-v4-flash-free',
        providerId: 'opencode',
        role: 'default',
        enabled: true,
        calls: 10,
        failures: 1,
        successRate: 90,
        avgLatencyMs: 1200,
        maxLatencyMs: 3000,
      },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }));

    expect(await listAdminModels()).toEqual(body);
    expect(fetch).toHaveBeenCalledWith('/api/admin/models', { credentials: 'include' });
  });

  it('addAdminModel posts a new model', async () => {
    const body = { id: 'new-model', providerId: 'opencode', role: null, enabled: true };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }));

    expect(await addAdminModel('new-model', 'opencode')).toEqual(body);
    expect(fetch).toHaveBeenCalledWith('/api/admin/models', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'new-model', providerID: 'opencode' }),
    });
  });

  it('updateAdminModel patches a model', async () => {
    const body = { id: 'big-pickle', providerId: 'opencode', role: 'default', enabled: true };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }));

    expect(await updateAdminModel('big-pickle', { role: 'default' })).toEqual(body);
    expect(fetch).toHaveBeenCalledWith('/api/admin/models/big-pickle', {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'default' }),
    });
  });

  it('getAdminSearch parses the search health payload', async () => {
    const body = { calls: 12, failures: 0, errorRate: 0, avgLatencyMs: 400, maxLatencyMs: 900, avgResultCount: 5, lastErrorAt: null };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }));

    expect(await getAdminSearch()).toEqual(body);
    expect(fetch).toHaveBeenCalledWith('/api/admin/search', { credentials: 'include' });
  });
});