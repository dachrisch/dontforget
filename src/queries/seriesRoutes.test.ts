import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { ObjectId } from 'mongodb';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../testSupport';
import { buildApp } from '../app';
import { CapturingEmailSender } from '../email/EmailSender';
import { SessionService, SESSION_COOKIE } from '../auth/session';
import { createQuery } from './queriesRepo';
import { insertDiscoveredSeries } from './seriesRepo';
import { flushSearches } from './searchQueue';

async function authenticatedUser(
  db: Db,
  deps: {
    runQuery?: (...args: never[]) => Promise<never>;
    discoverSeries?: (...args: never[]) => Promise<never>;
    runSeriesExpansion?: (...args: never[]) => Promise<never>;
  } & Record<string, unknown>,
  email = 'u@example.com'
) {
  const { insertedId } = await db.collection('users').insertOne({ email });
  const userId = insertedId.toString();
  const sessionId = await new SessionService(db).createSession(userId);
  const app = await buildApp({
    db,
    emailSender: new CapturingEmailSender(),
    publicBaseUrl: 'http://localhost:3000',
    frontendUrl: 'http://localhost:5173',
    runQuery: (deps.runQuery as never) ?? vi.fn().mockResolvedValue({ events: [], cadence: null }),
    discoverSeries: deps.discoverSeries as never,
    runSeriesExpansion: deps.runSeriesExpansion as never,
  });
  return { app, userId, sessionId };
}

function authHeaders(sessionId: string): Record<string, string> {
  return { cookie: `${SESSION_COOKIE}=${sessionId}` };
}

describe('series review routes', () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    ({ client, db } = await setupTestDb());
  });

  beforeEach(async () => {
    await cleanTestDb(db);
  });

  afterAll(async () => {
    await teardownTestDb(client);
  });

  it('GET /api/queries/:id/series requires auth', async () => {
    const { app } = await authenticatedUser(db, {});
    const response = await app.inject({ method: 'GET', url: '/api/queries/fake/series' });
    expect(response.statusCode).toBe(401);
  });

  it('GET lists series-review rows (identity, description, sources) for the owner', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db, {});
    const query = await createQuery(db, userId, 'events in munich');
    await insertDiscoveredSeries(db, query._id, userId, [
      { title: 'Oktoberfest', appliesTo: 'Oktoberfest, Munich', description: 'Beer festival', searchKeywords: 'Oktoberfest Munich', sourceUrls: ['https://a.example'] },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: `/api/queries/${query.queryId}/series`,
      headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        id: expect.any(String),
        title: 'Oktoberfest',
        appliesTo: 'Oktoberfest, Munich',
        description: 'Beer festival',
        searchKeywords: 'Oktoberfest Munich',
        sourceUrls: ['https://a.example'],
        status: 'candidate',
      },
    ]);
  });

  it('dashboard nests the dates preview under each series', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db, {});
    const query = await createQuery(db, userId, 'events in munich');
    const [series] = await insertDiscoveredSeries(db, query._id, userId, [
      { title: 'Auer Dult', appliesTo: 'Auer Dult, Munich', description: 'd', searchKeywords: 'Auer Dult Munich', sourceUrls: ['https://a.example'] },
    ]);
    const { completeSeriesExpansion } = await import('./queriesRepo');
    const { reviewSeries } = await import('./seriesRepo');
    await reviewSeries(db, userId, query.queryId, [series.id]);
    await completeSeriesExpansion(db, query._id, new ObjectId(series.id), [
      { label: 'Frühjahrsdult', startDate: '2099-04-11', endDate: '2099-05-11', sourceUrl: 'https://a.example' },
    ]);

    const response = await app.inject({ method: 'GET', url: '/api/queries', headers: authHeaders(sessionId) });
    expect(response.statusCode).toBe(200);
    const shown = response.json().queries[0].series[0];
    expect(shown.previewEvents).toEqual([
      { label: 'Frühjahrsdult', startDate: '2099-04-11', endDate: '2099-05-11' },
    ]);
  });

  it('PATCH text re-runs discovery in the background, keeping approvals', async () => {
    const discoverSeries = vi.fn().mockResolvedValue({
      series: [
        { title: 'Stadtfest Minden', appliesTo: 'Stadtfest Minden, Minden', description: 'd', searchKeywords: 'Stadtfest Minden Termine', sourceUrls: ['https://c.example'] },
      ],
    });
    const { app, userId, sessionId } = await authenticatedUser(db, { discoverSeries });
    const query = await createQuery(db, userId, 'events in minden');
    const { reviewSeries } = await import('./seriesRepo');
    const [old] = await insertDiscoveredSeries(db, query._id, userId, [
      { title: 'Oktoberfest', appliesTo: 'Oktoberfest, Munich', description: 'd', searchKeywords: 'Oktoberfest Munich', sourceUrls: ['https://a.example'] },
    ]);
    await reviewSeries(db, userId, query.queryId, [old.id]);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/queries/${query.queryId}`,
      headers: authHeaders(sessionId),
      payload: { text: 'Stadtfest Minden' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ text: 'Stadtfest Minden', status: 'running' });

    await flushSearches();
    expect(discoverSeries).toHaveBeenCalledWith('Stadtfest Minden');

    const rows = await db.collection('series').find({ query_id: query._id }).toArray();
    expect(rows).toHaveLength(2);
    const byTitle = Object.fromEntries(rows.map(r => [r.title, r.status]));
    // Old approval kept, fresh candidate merged in.
    expect(byTitle).toMatchObject({ Oktoberfest: 'approved', 'Stadtfest Minden': 'candidate' });
    const row = await db.collection('queries').findOne({ _id: query._id });
    expect(row?.status).toBe('ready');
  });

  it('PATCH interval-only does not trigger discovery', async () => {
    const discoverSeries = vi.fn();
    const { app, userId, sessionId } = await authenticatedUser(db, { discoverSeries });
    const query = await createQuery(db, userId, 'events in minden');

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/queries/${query.queryId}`,
      headers: authHeaders(sessionId),
      payload: { recurrenceInterval: 'monthly' },
    });
    expect(response.statusCode).toBe(200);
    await flushSearches();
    expect(discoverSeries).not.toHaveBeenCalled();
  });

  it('GET returns 403 for a query the user does not own', async () => {
    const { app, sessionId } = await authenticatedUser(db, {});
    const { insertedId } = await db.collection('users').insertOne({ email: 'other@example.com' });
    const otherQuery = await createQuery(db, insertedId.toString(), 'Not yours');

    const response = await app.inject({
      method: 'GET',
      url: `/api/queries/${otherQuery.queryId}/series`,
      headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(403);
  });

  it('POST review subscribes to the series and expands dates scoped to its identity', async () => {
    const runSeriesExpansion = vi.fn().mockResolvedValue({
      events: [{ label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://a.example' }],
      cadence: null,
    });
    const runQuery = vi.fn();
    const { app, userId, sessionId } = await authenticatedUser(db, { runQuery, runSeriesExpansion });
    const query = await createQuery(db, userId, 'events in munich');
    const [series] = await insertDiscoveredSeries(db, query._id, userId, [
      { title: 'Auer Dult', appliesTo: 'Auer Dult, Munich', description: 'd', searchKeywords: 'Auer Dult Munich Termine', sourceUrls: ['https://a.example'] },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: `/api/queries/${query.queryId}/series/review`,
      headers: authHeaders(sessionId),
      payload: { approveIds: [series.id] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()[0]).toMatchObject({ id: series.id, status: 'approved' });

    await flushSearches();
    // Series-scoped path: called with the series identity, not bare keywords.
    expect(runSeriesExpansion).toHaveBeenCalledWith(
      expect.objectContaining({ appliesTo: 'Auer Dult, Munich', searchKeywords: 'Auer Dult Munich Termine' })
    );
    expect(runQuery).not.toHaveBeenCalled();
    const events = await db.collection('events').find({ query_id: query._id }).toArray();
    expect(events).toHaveLength(1);
    expect(events[0].series_id.toString()).toBe(series.id);
    // Subscribed series land as approved without per-event re-approval.
    expect(events[0].status).toBe('approved');
  });

  it('POST expand returns dated events linked via series_id', async () => {
    const runQuery = vi.fn().mockResolvedValue({
      events: [{ label: 'Oktoberfest', startDate: '2026-09-19', endDate: '2026-10-04', sourceUrl: 'https://a.example' }],
      cadence: null,
    });
    const { app, userId, sessionId } = await authenticatedUser(db, { runQuery });
    const query = await createQuery(db, userId, 'events in munich');
    const [series] = await insertDiscoveredSeries(db, query._id, userId, [
      { title: 'Oktoberfest', appliesTo: 'Oktoberfest, Munich', description: 'd', searchKeywords: 'Oktoberfest Munich dates', sourceUrls: ['https://a.example'] },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: `/api/queries/${query.queryId}/series/${series.id}/expand`,
      headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()[0]).toMatchObject({ label: 'Oktoberfest', seriesId: series.id });
  });

  it('POST expand refuses a dismissed series', async () => {
    const runQuery = vi.fn();
    const { app, userId, sessionId } = await authenticatedUser(db, { runQuery });
    const query = await createQuery(db, userId, 'events in munich');
    const [series] = await insertDiscoveredSeries(db, query._id, userId, [
      { title: 'Oktoberfest', appliesTo: 'Oktoberfest, Munich', description: 'd', searchKeywords: 'Oktoberfest Munich dates', sourceUrls: ['https://a.example'] },
    ]);
    await app.inject({
      method: 'POST',
      url: `/api/queries/${query.queryId}/series/review`,
      headers: authHeaders(sessionId),
      payload: { dismissIds: [series.id] },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/queries/${query.queryId}/series/${series.id}/expand`,
      headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(409);
    expect(runQuery).not.toHaveBeenCalled();
  });

  it('POST refresh re-runs discovery without re-creating dismissed titles', async () => {
    const discoverSeries = vi.fn().mockResolvedValue({
      series: [
        { title: 'Oktoberfest', appliesTo: 'Oktoberfest, Munich', description: 'd', searchKeywords: 'Oktoberfest Munich', sourceUrls: ['https://a.example'] },
        { title: 'New Series', appliesTo: 'New Series, Munich', description: 'd', searchKeywords: 'New Series Munich', sourceUrls: ['https://c.example'] },
      ],
    });
    const { app, userId, sessionId } = await authenticatedUser(db, { discoverSeries });
    const query = await createQuery(db, userId, 'events in munich');
    const [existing] = await insertDiscoveredSeries(db, query._id, userId, [
      { title: 'Oktoberfest', appliesTo: 'Oktoberfest, Munich', description: 'd', searchKeywords: 'Oktoberfest Munich', sourceUrls: ['https://a.example'] },
    ]);
    await db.collection('series').updateOne({ _id: new ObjectId(existing.id) }, { $set: { status: 'dismissed' } });

    const response = await app.inject({
      method: 'POST',
      url: `/api/queries/${query.queryId}/series/refresh`,
      headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().map((s: { title: string }) => s.title)).toEqual(['New Series']);
    expect(discoverSeries).toHaveBeenCalledTimes(1);
  });
});
