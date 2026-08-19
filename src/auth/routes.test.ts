import { describe, it, expect, vi } from 'vitest';
import { buildApp } from '../app';
import { CapturingEmailSender } from '../email/EmailSender';
import { ObjectId, type Db } from 'mongodb';
import { FakeBillingGateway } from '../billing/stripeGateway';
import { BillingService } from '../billing/billingService';

// A real, valid ObjectId string — the session/user mocks must return one so
// requireAuth yields a usable userId and deleteAccount's ObjectId coercion
// doesn't throw (a fake like 'user-1' would blow up in `new ObjectId(...)`).
const USER_ID = new ObjectId().toString();

function fakeDb(): Db {
  const collection = {
    updateOne: vi.fn().mockResolvedValue(undefined),
    insertOne: vi.fn().mockResolvedValue(undefined),
    findOneAndUpdate: vi.fn().mockResolvedValue({ _id: USER_ID, user_id: USER_ID }),
    findOne: vi.fn().mockResolvedValue({ _id: USER_ID, user_id: USER_ID }),
    find: vi.fn().mockReturnValue({ toArray: () => Promise.resolve([]) }),
    deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 1 }),
  };
  return { collection: vi.fn().mockReturnValue(collection) } as unknown as Db;
}

describe('auth routes', () => {
  it('POST /api/auth/magic-link accepts an email and returns 202', async () => {
    const emailSender = new CapturingEmailSender();
    const app = await buildApp({
      db: fakeDb(),
      emailSender,
      publicBaseUrl: 'http://localhost:3000',
      frontendUrl: 'http://localhost:5173',
      runQuery: async () => ({ events: [], cadence: null }),
      billingService: new BillingService({} as any, new FakeBillingGateway(), 'price_graduated'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/magic-link',
      payload: { email: 'a@example.com' },
    });

    expect(response.statusCode).toBe(202);
    expect(emailSender.sent).toHaveLength(1);
  });

  it('POST /api/auth/magic-link returns 400, not 500, with no request body', async () => {
    const app = await buildApp({
      db: fakeDb(),
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      frontendUrl: 'http://localhost:5173',
      runQuery: vi.fn(),
      billingService: new BillingService({} as any, new FakeBillingGateway(), 'price_graduated'),
    });

    const response = await app.inject({ method: 'POST', url: '/api/auth/magic-link' });
    expect(response.statusCode).toBe(400);
  });

  it('POST /api/auth/magic-link returns 429 after the per-IP limit is exceeded', async () => {
    const emailSender = new CapturingEmailSender();
    const app = await buildApp({
      db: fakeDb(),
      emailSender,
      publicBaseUrl: 'http://localhost:3000',
      frontendUrl: 'http://localhost:5173',
      runQuery: async () => ({ events: [], cadence: null }),
      billingService: new BillingService({} as any, new FakeBillingGateway(), 'price_graduated'),
    });

    const responses: Awaited<ReturnType<typeof app.inject>>[] = [];
    for (let i = 0; i < 6; i++) {
      responses.push(
        await app.inject({ method: 'POST', url: '/api/auth/magic-link', payload: { email: 'a@example.com' } })
      );
    }

    expect(responses.slice(0, 5).map(r => r.statusCode)).toEqual([202, 202, 202, 202, 202]);
    expect(responses[5].statusCode).toBe(429);
  });

  it('GET /api/auth/callback returns 400 for a missing token', async () => {
    const app = await buildApp({
      db: fakeDb(),
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      frontendUrl: 'http://localhost:5173',
      runQuery: vi.fn(),
      billingService: new BillingService({} as any, new FakeBillingGateway(), 'price_graduated'),
    });

    const response = await app.inject({ method: 'GET', url: '/api/auth/callback' });
    expect(response.statusCode).toBe(400);
  });

  it('GET /api/auth/callback redirects to frontendUrl, not a hardcoded /', async () => {
    const app = await buildApp({
      db: fakeDb(),
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      frontendUrl: 'http://localhost:5173',
      runQuery: vi.fn(),
      billingService: new BillingService({} as any, new FakeBillingGateway(), 'price_graduated'),
    });

    const response = await app.inject({ method: 'GET', url: '/api/auth/callback?token=any-token' });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('http://localhost:5173');
  });

  it('GET /api/me returns 401 with no session cookie', async () => {
    const app = await buildApp({
      db: fakeDb(),
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      frontendUrl: 'http://localhost:5173',
      runQuery: async () => ({ events: [], cadence: null }),
      billingService: new BillingService({} as any, new FakeBillingGateway(), 'price_graduated'),
    });

    const response = await app.inject({ method: 'GET', url: '/api/me' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /api/me reports the signed-in user role', async () => {
    const app = await buildApp({
      db: fakeDb(),
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      frontendUrl: 'http://localhost:5173',
      runQuery: async () => ({ events: [], cadence: null }),
      billingService: new BillingService({} as any, new FakeBillingGateway(), 'price_graduated'),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/me',
      cookies: { df_session: 'session-1' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ authenticated: true, role: 'user' });
  });

  it('POST /api/auth/signout deletes the session and clears the cookie', async () => {
    const db = fakeDb();
    const app = await buildApp({
      db,
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      frontendUrl: 'http://localhost:5173',
      runQuery: async () => ({ events: [], cadence: null }),
      billingService: new BillingService({} as any, new FakeBillingGateway(), 'price_graduated'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/signout',
      cookies: { df_session: 'session-1' },
    });

    expect(response.statusCode).toBe(204);
    const collection = db.collection as unknown as (name: string) => {
      deleteOne: ReturnType<typeof vi.fn>;
    };
    expect(collection('sessions').deleteOne).toHaveBeenCalledWith({ _id: 'session-1' });
    expect(response.headers['set-cookie']).toMatch(/df_session=;/);
  });

  it('DELETE /api/auth/account wipes the user data and clears the session cookie', async () => {
    const db = fakeDb();
    const app = await buildApp({
      db,
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      frontendUrl: 'http://localhost:5173',
      runQuery: async () => ({ events: [], cadence: null }),
      billingService: new BillingService({} as any, new FakeBillingGateway(), 'price_graduated'),
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/auth/account',
      cookies: { df_session: 'session-1' },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['set-cookie']).toMatch(/df_session=;/);
    const collection = db.collection as unknown as (name: string) => {
      find: ReturnType<typeof vi.fn>;
      deleteMany: ReturnType<typeof vi.fn>;
      deleteOne: ReturnType<typeof vi.fn>;
    };
    expect(collection('queries').find).toHaveBeenCalledWith({ user_id: USER_ID }, { projection: { _id: 1 } });
    expect(collection('queries').deleteMany).toHaveBeenCalledWith({ user_id: USER_ID });
    expect(collection('feed_tokens').deleteMany).toHaveBeenCalledWith({ user_id: USER_ID });
    expect(collection('magic_links').deleteMany).toHaveBeenCalledWith({ user_id: USER_ID });
    expect(collection('sessions').deleteMany).toHaveBeenCalledWith({ user_id: USER_ID });
    expect(collection('users').deleteOne).toHaveBeenCalledWith({ _id: new ObjectId(USER_ID) });
  });

  it('DELETE /api/auth/account requires a session', async () => {
    const app = await buildApp({
      db: fakeDb(),
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      frontendUrl: 'http://localhost:5173',
      runQuery: async () => ({ events: [], cadence: null }),
      billingService: new BillingService({} as any, new FakeBillingGateway(), 'price_graduated'),
    });

    const response = await app.inject({ method: 'DELETE', url: '/api/auth/account' });
    expect(response.statusCode).toBe(401);
  });
});