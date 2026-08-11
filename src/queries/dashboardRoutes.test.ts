import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { ObjectId } from 'mongodb';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../testSupport';
import { buildApp } from '../app';
import { CapturingEmailSender } from '../email/EmailSender';
import { SessionService, SESSION_COOKIE } from '../auth/session';
import { createQueryWithCandidates } from './queriesRepo';
import { approveEvents } from './approveEvents';

async function authenticatedUser(db: Db, email = 'u@example.com') {
  const { insertedId } = await db.collection('users').insertOne({ email });
  const userId = insertedId.toString();
  const sessionId = await new SessionService(db).createSession(userId);
  const app = buildApp({
    db,
    emailSender: new CapturingEmailSender(),
    publicBaseUrl: 'http://localhost:3000',
    frontendUrl: 'http://localhost:5173',
    runQuery: vi.fn().mockResolvedValue([]),
  });
  return { app, userId, sessionId };
}

function authHeaders(sessionId: string): Record<string, string> {
  return { cookie: `${SESSION_COOKIE}=${sessionId}` };
}

describe('query dashboard routes', () => {
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

  it('GET /api/queries requires auth', async () => {
    const { app } = await authenticatedUser(db);
    const response = await app.inject({ method: 'GET', url: '/api/queries' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /api/queries returns an empty dashboard for a fresh user', async () => {
    const { app, sessionId } = await authenticatedUser(db);
    const response = await app.inject({
      method: 'GET',
      url: '/api/queries',
      headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ queries: [], feed: null });
  });

  it('GET /api/queries returns the user\u2019s queries and feed info', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db);
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u' },
    ]);
    await approveEvents(db, userId, queryId, [candidates[0].id], 'http://localhost:3000');

    const response = await app.inject({
      method: 'GET',
      url: '/api/queries',
      headers: authHeaders(sessionId),
    });
    const body = response.json();
    expect(body.queries[0]).toMatchObject({
      id: queryId,
      text: 'Auer Dult Munich',
      recurrenceInterval: 'monthly',
      approvedCount: 1,
      candidateCount: 0,
    });
    expect(body.feed.icsUrl).toMatch(/^http:\/\/localhost:3000\/f\/.+\.ics$/);
    expect(body.feed.rssUrl).toMatch(/^http:\/\/localhost:3000\/f\/.+\.rss$/);
  });

  it('PATCH /api/queries/:id updates text and schedule', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db);
    const { queryId } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', []);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/queries/${queryId}`,
      headers: authHeaders(sessionId),
      payload: { text: 'Auer Dult', recurrenceInterval: 'weekly' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: queryId, text: 'Auer Dult', recurrenceInterval: 'weekly' });
  });

  it('PATCH rejects an invalid recurrence interval', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db);
    const { queryId } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', []);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/queries/${queryId}`,
      headers: authHeaders(sessionId),
      payload: { recurrenceInterval: 'sometimes' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('PATCH rejects an empty query text', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db);
    const { queryId } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', []);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/queries/${queryId}`,
      headers: authHeaders(sessionId),
      payload: { text: '   ' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('PATCH returns 403 for a query the user does not own', async () => {
    const { app, sessionId } = await authenticatedUser(db);
    const { userId: otherUserId } = await authenticatedUser(db, 'other@example.com');
    const { queryId } = await createQueryWithCandidates(db, otherUserId, 'Not yours', []);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/queries/${queryId}`,
      headers: authHeaders(sessionId),
      payload: { text: 'hijack' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('POST /api/queries stores an explicit recurrence interval', async () => {
    const { app, sessionId, userId } = await authenticatedUser(db);
    const runQuery = vi.fn().mockResolvedValue([
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u' },
    ]);
    const intervalApp = buildApp({
      db,
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      frontendUrl: 'http://localhost:5173',
      runQuery,
    });

    const response = await intervalApp.inject({
      method: 'POST',
      url: '/api/queries',
      headers: authHeaders(sessionId),
      payload: { text: 'Auer Dult Munich', recurrenceInterval: 'quarterly' },
    });

    expect(response.statusCode).toBe(200);
    expect(runQuery).toHaveBeenCalledWith('Auer Dult Munich');
    const { queryId } = response.json();
    const row = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });
    expect(row?.user_id).toBe(userId);
    expect(row?.recurrence_interval).toBe('quarterly');
  });

  it('POST rejects an invalid recurrence interval', async () => {
    const { app, sessionId } = await authenticatedUser(db);
    const response = await app.inject({
      method: 'POST',
      url: '/api/queries',
      headers: authHeaders(sessionId),
      payload: { text: 'Auer Dult Munich', recurrenceInterval: 'sometimes' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('GET /api/queries/:id/events lists approved and pending events for the owner', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db);
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u1' },
      { label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'u2' },
    ]);
    await approveEvents(db, userId, queryId, [candidates[0].id], 'http://localhost:3000');

    const response = await app.inject({
      method: 'GET',
      url: `/api/queries/${queryId}/events`,
      headers: authHeaders(sessionId),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { id: candidates[0].id, label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u1', status: 'approved' },
      { id: candidates[1].id, label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'u2', status: 'candidate' },
    ]);
  });

  it('GET /api/queries/:id/events returns 403 for a query the user does not own', async () => {
    const { app, sessionId } = await authenticatedUser(db);
    const { userId: otherUserId } = await authenticatedUser(db, 'other@example.com');
    const { queryId } = await createQueryWithCandidates(db, otherUserId, 'Not yours', []);

    const response = await app.inject({
      method: 'GET',
      url: `/api/queries/${queryId}/events`,
      headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(403);
  });

  it('DELETE /api/queries/:id removes the query and its events', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db);
    const { queryId } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u' },
    ]);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/queries/${queryId}`,
      headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(204);

    const queryLeft = await db.collection('queries').countDocuments({ _id: new ObjectId(queryId) });
    const eventsLeft = await db.collection('events').countDocuments({ query_id: new ObjectId(queryId) });
    expect(queryLeft).toBe(0);
    expect(eventsLeft).toBe(0);
  });

  it('DELETE /api/queries/:id returns 403 for a query the user does not own', async () => {
    const { app, sessionId } = await authenticatedUser(db);
    const { userId: otherUserId } = await authenticatedUser(db, 'other@example.com');
    const { queryId } = await createQueryWithCandidates(db, otherUserId, 'Not yours', []);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/queries/${queryId}`,
      headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(403);
  });

  it('POST /api/feed/rotate requires auth', async () => {
    const { app } = await authenticatedUser(db);
    const response = await app.inject({ method: 'POST', url: '/api/feed/rotate' });
    expect(response.statusCode).toBe(401);
  });

  it('POST /api/feed/rotate mints a new URL and retires the old one', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db);
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u' },
    ]);
    const { icsUrl: originalIcsUrl } = (await approveEvents(db, userId, queryId, [candidates[0].id], 'http://localhost:3000'))!;

    const response = await app.inject({
      method: 'POST',
      url: '/api/feed/rotate',
      headers: authHeaders(sessionId),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.icsUrl).toMatch(/^http:\/\/localhost:3000\/f\/.+\.ics$/);
    expect(body.icsUrl).not.toBe(originalIcsUrl);

    const oldToken = originalIcsUrl.split('/f/')[1]!.replace('.ics', '');
    const staleLookup = await app.inject({ method: 'GET', url: `/f/${oldToken}.ics` });
    expect(staleLookup.statusCode).toBe(404);
  });
});