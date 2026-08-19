import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../testSupport';
import { buildApp } from '../app';
import { CapturingEmailSender } from '../email/EmailSender';
import { FakeBillingGateway } from './stripeGateway';
import { BillingService } from './billingService';

describe('POST /api/billing/webhook', () => {
  let client: MongoClient;
  let db: Db;
  let gateway: FakeBillingGateway;
  let app: any;

  function event(id: string, type: string, object: Record<string, unknown>) {
    return { id, type, data: { object } } as any;
  }

  beforeAll(async () => {
    ({ client, db } = await setupTestDb());
  });

  beforeEach(async () => {
    await cleanTestDb(db);
    gateway = new FakeBillingGateway();
    app = await buildApp({
      db,
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      frontendUrl: 'http://localhost:5173',
      runQuery: async () => ({ events: [], cadence: null }),
      billingService: new BillingService(db, gateway, 'price_graduated'),
      webhookSecret: 'whsec_test',
    });
  });

  afterAll(async () => {
    await teardownTestDb(client);
  });

  it('updates the user on checkout.session.completed', async () => {
    await db.collection('users').insertOne({ email: 'w@example.com', stripe_customer_id: 'cus_w' });
    gateway.queuedEvent = event('evt_checkout', 'checkout.session.completed', {
      customer: 'cus_w',
      subscription: 'sub_w',
      subscription_status: 'active',
    } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=sig' },
      payload: JSON.stringify(gateway.queuedEvent),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    const row = await db.collection('users').findOne({ email: 'w@example.com' });
    expect(row?.stripe_subscription_id).toBe('sub_w');
    expect(row?.stripe_subscription_status).toBe('active');
  });

  it('rejects a bad signature with 400', async () => {
    gateway.signatureValid = false;
    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=bogus' },
      payload: JSON.stringify({}),
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 503 when no webhook secret is configured', async () => {
    const noSecretApp = await buildApp({
      db,
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
      frontendUrl: 'http://localhost:5173',
      runQuery: async () => ({ events: [], cadence: null }),
      billingService: new BillingService(db, gateway, 'price_graduated'),
    });
    const response = await noSecretApp.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=sig' },
      payload: '{}',
    });
    expect(response.statusCode).toBe(503);
  });
});
