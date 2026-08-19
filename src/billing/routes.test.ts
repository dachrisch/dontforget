import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../testSupport';
import { buildApp } from '../app';
import { CapturingEmailSender } from '../email/EmailSender';
import { SessionService, SESSION_COOKIE } from '../auth/session';
import { FakeBillingGateway, NullBillingGateway, BillingUnavailableError } from './stripeGateway';
import { BillingService } from './billingService';

describe('billing routes', () => {
  let client: MongoClient;
  let db: Db;
  let gateway: FakeBillingGateway;

  async function appWith(gatewayOverride?: FakeBillingGateway) {
    gateway = gatewayOverride ?? new FakeBillingGateway();
    return buildApp({
      db,
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      frontendUrl: 'http://localhost:5173',
      runQuery: async () => ({ events: [], cadence: null }),
      billingService: new BillingService(db, gateway, 'price_graduated'),
      webhookSecret: 'whsec_test',
    });
  }

  async function signedInUser(): Promise<{ app: any; sessionId: string }> {
    const { insertedId } = await db.collection('users').insertOne({ email: 'c@example.com' });
    const sessionId = await new SessionService(db).createSession(insertedId.toString());
    const app = await appWith();
    return { app, sessionId };
  }

  beforeAll(async () => {
    ({ client, db } = await setupTestDb());
  });

  beforeEach(async () => {
    await cleanTestDb(db);
  });

  afterAll(async () => {
    await teardownTestDb(client);
  });

  it('POST /api/billing/checkout requires auth', async () => {
    const { app } = await signedInUser();
    const response = await app.inject({ method: 'POST', url: '/api/billing/checkout' });
    expect(response.statusCode).toBe(401);
  });

  it('POST /api/billing/checkout redirects to Stripe', async () => {
    const { app, sessionId } = await signedInUser();
    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(gateway.checkoutUrl);
  });

  it('GET /api/billing/portal redirects to the customer portal', async () => {
    const { app, sessionId } = await signedInUser();
    const response = await app.inject({
      method: 'GET',
      url: '/api/billing/portal',
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(gateway.portalUrl);
  });

  it('GET /api/billing/status returns the quota payload', async () => {
    const { app, sessionId } = await signedInUser();
    const response = await app.inject({
      method: 'GET',
      url: '/api/billing/status',
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ freeLimit: 1, subscribed: false, activeQueryCount: 0 });
  });

  it('checkout returns 503 when billing is unavailable (no Stripe config)', async () => {
    const { insertedId } = await db.collection('users').insertOne({ email: 'd@example.com' });
    const sessionId = await new SessionService(db).createSession(insertedId.toString());
    const app = await buildApp({
      db,
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      frontendUrl: 'http://localhost:5173',
      runQuery: async () => ({ events: [], cadence: null }),
      billingService: new BillingService(db, new NullBillingGateway(), 'price_graduated'),
      webhookSecret: 'whsec_test',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    expect(response.statusCode).toBe(503);
    expect(BillingUnavailableError).toBeDefined();
  });
});
