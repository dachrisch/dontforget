import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { ObjectId } from 'mongodb';
import { setupTestDb, cleanTestDb, teardownTestDb, createQueryWithCandidates } from '../testSupport';
import { buildApp } from '../app';
import { CapturingEmailSender } from '../email/EmailSender';
import { SessionService, SESSION_COOKIE } from '../auth/session';
import { createModelRegistry } from '../search/models';
import { createMetricsService } from '../search/metrics';

async function appFor(db: Db) {
  return buildApp({
    db,
    emailSender: new CapturingEmailSender(),
    publicBaseUrl: 'http://localhost:3000',
    frontendUrl: 'http://localhost:5173',
    runQuery: vi.fn().mockResolvedValue({ events: [], cadence: null }),
    modelRegistry: createModelRegistry({ db }),
    metrics: createMetricsService(db),
  });
}

async function userWithRole(db: Db, email: string, role: 'admin' | 'user') {
  const { insertedId } = await db.collection('users').insertOne({
    email,
    created_at: new Date(),
    ...(role === 'admin' ? { role: 'admin' } : {}),
  });
  const userId = insertedId.toString();
  const sessionId = await new SessionService(db).createSession(userId);
  return { userId, sessionId };
}

function authHeaders(sessionId: string): Record<string, string> {
  return { cookie: `${SESSION_COOKIE}=${sessionId}` };
}

describe('admin routes', () => {
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

  it('rejects every endpoint without a session', async () => {
    const app = await appFor(db);
    for (const [method, url] of [
      ['GET', '/api/admin/stats'],
      ['GET', '/api/admin/users'],
      ['DELETE', `/api/admin/users/${new ObjectId()}`],
    ] as const) {
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(401);
    }
  });

  it('rejects a signed-in non-admin with 403', async () => {
    const app = await appFor(db);
    const { sessionId } = await userWithRole(db, 'u@example.com', 'user');

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/stats',
      headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(403);
  });

  it('GET /api/admin/stats rolls up user, query and event counts', async () => {
    const app = await appFor(db);
    const { sessionId } = await userWithRole(db, 'admin@example.com', 'admin');

    const other = await userWithRole(db, 'u@example.com', 'user');
    await createQueryWithCandidates(db, other.userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u1' },
      { label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'u2' },
    ]);
    await db.collection('queries').insertOne({
      user_id: other.userId,
      query_text: 'Oktoberfest',
      created_at: new Date(),
      last_run_at: new Date(),
      status: 'ready',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/stats',
      headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      totalUsers: 2,
      totalQueries: 2,
      approvedEvents: 0,
      candidateEvents: 2,
      activeUsers7d: 1,
    });
  });

  it('GET /api/admin/users lists users with their query counts', async () => {
    const app = await appFor(db);
    const { sessionId } = await userWithRole(db, 'admin@example.com', 'admin');

    const { userId } = await userWithRole(db, 'u@example.com', 'user');
    await createQueryWithCandidates(db, userId, 'Auer Dult Munich', []);

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(200);
    const users = response.json();
    expect(users).toHaveLength(2);
    const admin = users.find((u: { email: string }) => u.email === 'admin@example.com');
    const user = users.find((u: { email: string }) => u.email === 'u@example.com');
    expect(admin).toMatchObject({ role: 'admin', queryCount: 0 });
    expect(admin.createdAt).toBeTruthy();
    expect(user).toMatchObject({ role: 'user', queryCount: 1 });
  });

  it('DELETE /api/admin/users/:id cascades through the target account', async () => {
    const app = await appFor(db);
    const { sessionId } = await userWithRole(db, 'admin@example.com', 'admin');

    const { userId } = await userWithRole(db, 'u@example.com', 'user');
    const { queryId } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u1' },
    ]);
    await db.collection('feed_tokens').insertOne({ user_id: userId, token: 'tok' });
    await db
      .collection<{ _id: string; user_id: string; expires_at: Date }>('sessions')
      .insertOne({ _id: 'sess', user_id: userId, expires_at: new Date() });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${userId}`,
      headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(204);
    expect(await db.collection('users').countDocuments({ _id: new ObjectId(userId) })).toBe(0);
    expect(await db.collection('queries').countDocuments({ _id: new ObjectId(queryId) })).toBe(0);
    expect(await db.collection('events').countDocuments({})).toBe(0);
    expect(await db.collection('feed_tokens').countDocuments({})).toBe(0);
  });

  it('refuses to delete the admin account that is making the request', async () => {
    const app = await appFor(db);
    const { userId, sessionId } = await userWithRole(db, 'admin@example.com', 'admin');

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${userId}`,
      headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(403);
    expect(await db.collection('users').countDocuments({ _id: new ObjectId(userId) })).toBe(1);
  });

  it('returns 400 for a malformed user id', async () => {
    const app = await appFor(db);
    const { sessionId } = await userWithRole(db, 'admin@example.com', 'admin');

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/admin/users/not-an-objectid',
      headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(400);
  });

  it('GET /api/admin/models lists seeded models with zeroed metrics', async () => {
    const app = await appFor(db);
    const { sessionId } = await userWithRole(db, 'admin@example.com', 'admin');

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/models',
      headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(200);
    const models = response.json();
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({ id: 'qwen3.7-flash', role: 'default', enabled: true });
    expect(models[1]).toMatchObject({ id: 'antigravity-gemini-3-flash', role: 'backup', enabled: true });
    expect(models[0].calls).toBe(0);
    expect(models[0].successRate).toBeNull();
  });

  it('PATCH /api/admin/models/:id switches default and retires models', async () => {
    const app = await appFor(db);
    const { sessionId } = await userWithRole(db, 'admin@example.com', 'admin');

    // Promote the backup to default, then retire the old default.
    const promote = await app.inject({
      method: 'PATCH',
      url: '/api/admin/models/antigravity-gemini-3-flash',
      headers: authHeaders(sessionId),
      payload: { role: 'default' },
    });
    expect(promote.statusCode).toBe(200);
    expect(promote.json()).toMatchObject({ id: 'antigravity-gemini-3-flash', role: 'default' });

    const retire = await app.inject({
      method: 'PATCH',
      url: '/api/admin/models/qwen3.7-flash',
      headers: authHeaders(sessionId),
      payload: { enabled: false },
    });
    expect(retire.statusCode).toBe(200);
    expect(retire.json()).toMatchObject({ id: 'qwen3.7-flash', enabled: false });

    const models = (await app.inject({
      method: 'GET',
      url: '/api/admin/models',
      headers: authHeaders(sessionId),
    })).json();
    const defaultModel = models.find((m: { id: string }) => m.id === 'antigravity-gemini-3-flash');
    expect(defaultModel.role).toBe('default');
  });

  it('POST /api/admin/models adds a model and rejects duplicates', async () => {
    const app = await appFor(db);
    const { sessionId } = await userWithRole(db, 'admin@example.com', 'admin');

    const add = await app.inject({
      method: 'POST',
      url: '/api/admin/models',
      headers: authHeaders(sessionId),
      payload: { id: 'new-model', providerID: 'opencode' },
    });
    expect(add.statusCode).toBe(201);
    expect(add.json()).toMatchObject({ id: 'new-model', enabled: true, role: null });

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/admin/models',
      headers: authHeaders(sessionId),
      payload: { id: 'new-model', providerID: 'opencode' },
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it('GET /api/admin/search reports call volume and failure rate', async () => {
    const app = await appFor(db);
    const { sessionId } = await userWithRole(db, 'admin@example.com', 'admin');

    const now = new Date();
    await db.collection('search_metrics').insertMany([
      { outcome: 'success', result_count: 5, duration_ms: 400, created_at: now },
      { outcome: 'success', result_count: 3, duration_ms: 600, created_at: now },
      { outcome: 'failure', error_type: 'searxng request failed: 500', result_count: 0, duration_ms: 800, created_at: now },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/search',
      headers: authHeaders(sessionId),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ calls: 3, failures: 1, errorRate: 33.3 });
    expect(response.json().avgLatencyMs).toBe(600);
  });
});