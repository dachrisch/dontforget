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
  deps: { runQuery?: (...args: never[]) => Promise<never>; discoverSeries?: (...args: never[]) => Promise<never> } & Record<string, unknown>,
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

  it('GET lists series-review rows (title, description, sources) for the owner', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db, {});
    const query = await createQuery(db, userId, 'events in munich');
    await insertDiscoveredSeries(db, query._id, userId, [
      { title: 'Oktoberfest', description: 'Beer festival', searchKeywords: 'Oktoberfest Munich', sourceUrls: ['https://a.example'] },
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
        description: 'Beer festival',
        searchKeywords: 'Oktoberfest Munich',
        sourceUrls: ['https://a.example'],
        status: 'candidate',
      },
    ]);
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

  it('POST review approves series and expands them into dated events in the background', async () => {
    const runQuery = vi.fn().mockResolvedValue({
      events: [{ label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://a.example' }],
      cadence: null,
    });
    const { app, userId, sessionId } = await authenticatedUser(db, { runQuery });
    const query = await createQuery(db, userId, 'events in munich');
    const [series] = await insertDiscoveredSeries(db, query._id, userId, [
      { title: 'Auer Dult', description: 'd', searchKeywords: 'Auer Dult Munich dates', sourceUrls: ['https://a.example'] },
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
    expect(runQuery).toHaveBeenCalledWith('Auer Dult Munich dates');
    const events = await db.collection('events').find({ query_id: query._id }).toArray();
    expect(events).toHaveLength(1);
    expect(events[0].series_id.toString()).toBe(series.id);
  });

  it('POST expand returns dated events linked via series_id', async () => {
    const runQuery = vi.fn().mockResolvedValue({
      events: [{ label: 'Oktoberfest', startDate: '2026-09-19', endDate: '2026-10-04', sourceUrl: 'https://a.example' }],
      cadence: null,
    });
    const { app, userId, sessionId } = await authenticatedUser(db, { runQuery });
    const query = await createQuery(db, userId, 'events in munich');
    const [series] = await insertDiscoveredSeries(db, query._id, userId, [
      { title: 'Oktoberfest', description: 'd', searchKeywords: 'Oktoberfest Munich dates', sourceUrls: ['https://a.example'] },
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
      { title: 'Oktoberfest', description: 'd', searchKeywords: 'Oktoberfest Munich dates', sourceUrls: ['https://a.example'] },
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
        { title: 'Oktoberfest', description: 'd', searchKeywords: 'Oktoberfest Munich', sourceUrls: ['https://a.example'] },
        { title: 'New Series', description: 'd', searchKeywords: 'New Series Munich', sourceUrls: ['https://c.example'] },
      ],
    });
    const { app, userId, sessionId } = await authenticatedUser(db, { discoverSeries });
    const query = await createQuery(db, userId, 'events in munich');
    const [existing] = await insertDiscoveredSeries(db, query._id, userId, [
      { title: 'Oktoberfest', description: 'd', searchKeywords: 'Oktoberfest Munich', sourceUrls: ['https://a.example'] },
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
