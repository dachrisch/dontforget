import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { ObjectId } from 'mongodb';
import { setupTestDb, cleanTestDb, teardownTestDb, createQueryWithCandidates } from '../testSupport';
import { buildApp } from '../app';
import { CapturingEmailSender } from '../email/EmailSender';
import { SessionService, SESSION_COOKIE } from '../auth/session';
import { approveEvents } from './approveEvents';
import { flushSearches } from './searchQueue';
import { FakeBillingGateway } from '../billing/stripeGateway';
import { BillingService } from '../billing/billingService';

async function authenticatedUser(db: Db, email = 'u@example.com') {
  const { insertedId } = await db.collection('users').insertOne({ email });
  const userId = insertedId.toString();
  const sessionId = await new SessionService(db).createSession(userId);
  const app = await buildApp({
    db,
    emailSender: new CapturingEmailSender(),
    publicBaseUrl: 'http://localhost:3000',
    frontendUrl: 'http://localhost:5173',
    runQuery: vi.fn().mockResolvedValue({ events: [], cadence: null }),
    billingService: new BillingService(db, new FakeBillingGateway(), 'price_graduated'),
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
      recurrenceInterval: 'weekly',
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

  it('POST /api/queries returns 202 and stores an explicit recurrence interval once the search lands', async () => {
    const { app, sessionId, userId } = await authenticatedUser(db);
    const runQuery = vi.fn().mockResolvedValue({
      events: [{ label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u' }],
      cadence: null,
    });
    const intervalApp = await buildApp({
      db,
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      frontendUrl: 'http://localhost:5173',
      runQuery,
      billingService: new BillingService(db, new FakeBillingGateway(), 'price_graduated'),
    });

    const response = await intervalApp.inject({
      method: 'POST',
      url: '/api/queries',
      headers: authHeaders(sessionId),
      payload: { text: 'Auer Dult Munich', recurrenceInterval: 'quarterly' },
    });

    expect(response.statusCode).toBe(202);
    expect(runQuery).toHaveBeenCalledWith('Auer Dult Munich');
    const { queryId } = response.json();
    const row = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });
    expect(row?.user_id).toBe(userId);
    expect(row?.recurrence_interval).toBe('quarterly');

    await flushSearches();
    const landed = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });
    expect(landed?.status).toBe('ready');
    expect(landed?.recurrence_interval).toBe('quarterly');
  });

  it('POST /api/queries applies the AI cadence when the client chose none', async () => {
    const { app, sessionId } = await authenticatedUser(db);
    const runQuery = vi.fn().mockResolvedValue({
      events: [{ label: 'Auer Dult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u' }],
      cadence: 'yearly',
    });
    const intervalApp = await buildApp({
      db,
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      frontendUrl: 'http://localhost:5173',
      runQuery,
      billingService: new BillingService(db, new FakeBillingGateway(), 'price_graduated'),
    });

    const response = await intervalApp.inject({
      method: 'POST',
      url: '/api/queries',
      headers: authHeaders(sessionId),
      payload: { text: 'Auer Dult Munich' },
    });

    expect(response.statusCode).toBe(202);
    const { queryId } = response.json();
    await flushSearches();
    const row = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });
    expect(row?.recurrence_interval).toBe('yearly');
  });

  it('POST /api/queries prefers an explicit interval over the AI cadence', async () => {
    const { app, sessionId } = await authenticatedUser(db);
    const runQuery = vi.fn().mockResolvedValue({
      events: [{ label: 'Auer Dult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u' }],
      cadence: 'yearly',
    });
    const intervalApp = await buildApp({
      db,
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      frontendUrl: 'http://localhost:5173',
      runQuery,
      billingService: new BillingService(db, new FakeBillingGateway(), 'price_graduated'),
    });

    const response = await intervalApp.inject({
      method: 'POST',
      url: '/api/queries',
      headers: authHeaders(sessionId),
      payload: { text: 'Auer Dult Munich', recurrenceInterval: 'monthly' },
    });

    expect(response.statusCode).toBe(202);
    const { queryId } = response.json();
    await flushSearches();
    const row = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });
    expect(row?.recurrence_interval).toBe('monthly');
  });

  it('POST keeps the query running until the background search lands, then the dashboard reflects it', async () => {
    const { app, sessionId } = await authenticatedUser(db);
    let resolveRun!: (value: { events: never[]; cadence: null }) => void;
    const runQuery = vi.fn().mockReturnValue(new Promise(r => (resolveRun = r)));
    const asyncApp = await buildApp({
      db,
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      frontendUrl: 'http://localhost:5173',
      runQuery,
      billingService: new BillingService(db, new FakeBillingGateway(), 'price_graduated'),
    });

    const response = await asyncApp.inject({
      method: 'POST',
      url: '/api/queries',
      headers: authHeaders(sessionId),
      payload: { text: 'Oktoberfest Munich' },
    });
    expect(response.statusCode).toBe(202);
    const { queryId } = response.json();

    const row = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });
    expect(row?.status).toBe('running');

    const runningDashboard = await asyncApp.inject({
      method: 'GET',
      url: '/api/queries',
      headers: authHeaders(sessionId),
    });
    expect(runningDashboard.json().queries[0]).toMatchObject({ id: queryId, status: 'running' });

    resolveRun({ events: [], cadence: null });
    await flushSearches();

    const landed = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });
    expect(landed?.status).toBe('ready');
  });

  it('POST marks the query failed when the background search throws', async () => {
    const { app, sessionId } = await authenticatedUser(db);
    const runQuery = vi.fn().mockRejectedValue(new Error('searxng is down'));
    const asyncApp = await buildApp({
      db,
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      frontendUrl: 'http://localhost:5173',
      runQuery,
      billingService: new BillingService(db, new FakeBillingGateway(), 'price_graduated'),
    });

    const response = await asyncApp.inject({
      method: 'POST',
      url: '/api/queries',
      headers: authHeaders(sessionId),
      payload: { text: 'Oktoberfest Munich' },
    });
    expect(response.statusCode).toBe(202);
    const { queryId } = response.json();

    await flushSearches();
    const row = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });
    expect(row?.status).toBe('failed');
  });

  it('POST /api/queries/:id/run re-runs a failed query in the background', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db);
    const { queryId } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', []);
    await db.collection('queries').updateOne({ _id: new ObjectId(queryId) }, { $set: { status: 'failed' } });
    const runQuery = vi.fn().mockResolvedValue({
      events: [{ label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u' }],
      cadence: null,
    });
    const asyncApp = await buildApp({
      db,
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      frontendUrl: 'http://localhost:5173',
      runQuery,
      billingService: new BillingService(db, new FakeBillingGateway(), 'price_graduated'),
    });

    const response = await asyncApp.inject({
      method: 'POST',
      url: `/api/queries/${queryId}/run`,
      headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ queryId });

    const running = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });
    expect(running?.status).toBe('running');

    await flushSearches();
    const landed = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });
    expect(landed?.status).toBe('ready');
    const events = await db.collection('events').find({ query_id: new ObjectId(queryId) }).toArray();
    expect(events).toHaveLength(1);
  });

  it('POST /api/queries/:id/run rejects a query already running', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db);
    const { queryId } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', []);
    await db.collection('queries').updateOne({ _id: new ObjectId(queryId) }, { $set: { status: 'running' } });

    const response = await app.inject({
      method: 'POST',
      url: `/api/queries/${queryId}/run`,
      headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(409);
  });

  it('POST /api/queries/:id/run returns 403 for a query the user does not own', async () => {
    const { app, sessionId } = await authenticatedUser(db);
    const { userId: otherUserId } = await authenticatedUser(db, 'other@example.com');
    const { queryId } = await createQueryWithCandidates(db, otherUserId, 'Not yours', []);

    const response = await app.inject({
      method: 'POST',
      url: `/api/queries/${queryId}/run`,
      headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(403);
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

  it('POST /api/queries/:id/approve dismisses events sent in dismissEventIds', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db);
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u1' },
      { label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'u2' },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: `/api/queries/${queryId}/approve`,
      headers: authHeaders(sessionId),
      payload: { eventIds: [candidates[0].id], dismissEventIds: [candidates[1].id] },
    });

    expect(response.statusCode).toBe(200);
    const rows = await db.collection('events').find({ query_id: new ObjectId(queryId) }).toArray();
    const byLabel = Object.fromEntries(rows.map(r => [r.label as string, r.status as string]));
    expect(byLabel['Frühjahrsdult']).toBe('approved');
    expect(byLabel['Jakobidult']).toBe('dismissed');
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

  it('POST /api/queries allows the first (free) query', async () => {
    const { app, sessionId } = await authenticatedUser(db);
    const response = await app.inject({
      method: 'POST',
      url: '/api/queries',
      headers: authHeaders(sessionId),
      payload: { text: 'Oktoberfest' },
    });
    expect(response.statusCode).toBe(202);
  });

  it('POST /api/queries always creates the query, even at capacity', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db);
    await createQueryWithCandidates(db, userId, 'Oktoberfest', []);

    const response = await app.inject({
      method: 'POST',
      url: '/api/queries',
      headers: authHeaders(sessionId),
      payload: { text: 'Auer Dult' },
    });
    expect(response.statusCode).toBe(202);

    const row = await db.collection('queries').findOne({ user_id: userId, query_text: 'Auer Dult' });
    expect(row?.status).toBe('blocked');
    expect(row?.active).toBe(false);
  });

  it('POST /api/queries allows a second query for a subscribed user with a free slot', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db);
    await createQueryWithCandidates(db, userId, 'Oktoberfest', []);
    await db.collection('users').updateOne({ _id: new ObjectId(userId) }, {
      $set: { stripe_subscription_id: 'sub_1', stripe_subscription_status: 'active', stripe_subscription_quantity: 2 },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/queries',
      headers: authHeaders(sessionId),
      payload: { text: 'Auer Dult' },
    });
    expect(response.statusCode).toBe(202);
    const row = await db.collection('queries').findOne({ user_id: userId, query_text: 'Auer Dult' });
    expect(row?.status).toBe('running');
    expect(row?.active).toBe(true);
  });

  it('DELETE syncs the subscription quantity down', async () => {
    const { app, userId, sessionId } = await authenticatedUser(db);
    const { queryId } = await createQueryWithCandidates(db, userId, 'Oktoberfest', []);
    await db.collection('users').updateOne({ _id: new ObjectId(userId) }, {
      $set: { stripe_subscription_id: 'sub_1', stripe_subscription_status: 'active' },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/queries/${queryId}`,
      headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(204);
  });
});