import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { ObjectId } from 'mongodb';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../testSupport';
import { FakeBillingGateway } from './stripeGateway';
import { BillingService, isOverFreeLimit } from './billingService';

describe('BillingService', () => {
  let client: MongoClient;
  let db: Db;
  let gateway: FakeBillingGateway;
  let service: BillingService;
  let userId: string;

  async function insertUser(overrides: Record<string, unknown> = {}): Promise<string> {
    const { insertedId } = await db.collection('users').insertOne({ email: 'b@example.com', ...overrides });
    return insertedId.toString();
  }

  beforeAll(async () => {
    ({ client, db } = await setupTestDb());
  });

  beforeEach(async () => {
    await cleanTestDb(db);
    gateway = new FakeBillingGateway();
    service = new BillingService(db, gateway, 'price_graduated');
    userId = await insertUser();
  });

  afterAll(async () => {
    await teardownTestDb(client);
  });

  it('isOverFreeLimit: 0 and 1 queries are free, 2 are over', async () => {
    expect(await isOverFreeLimit(db, userId)).toBe(false);
    await db.collection('queries').insertOne({ user_id: userId, query_text: 'a' });
    expect(await isOverFreeLimit(db, userId)).toBe(false);
    await db.collection('queries').insertOne({ user_id: userId, query_text: 'b' });
    expect(await isOverFreeLimit(db, userId)).toBe(true);
  });

  it('checkout creates and reuses one customer, starts at quantity 1, and persists the customer id', async () => {
    const { url } = await service.createCheckoutSession(userId, 'http://localhost:3000');
    expect(url).toBe(gateway.checkoutUrl);
    expect(gateway.createdCustomers).toEqual(['b@example.com']);
    expect(gateway.checkoutCalls).toHaveLength(1);
    expect(gateway.checkoutCalls[0].quantity).toBe(1);
    expect(gateway.checkoutCalls[0].priceId).toBe('price_graduated');

    await service.createCheckoutSession(userId, 'http://localhost:3000');
    expect(gateway.createdCustomers).toEqual(['b@example.com']); // no second customer
    const row = await db.collection('users').findOne({ _id: new ObjectId(userId) });
    expect(row?.stripe_customer_id).toBe('cus_test');
  });

  it('checkout starts quantity at the active query count', async () => {
    await db.collection('queries').insertOne({ user_id: userId, query_text: 'a' });
    await db.collection('queries').insertOne({ user_id: userId, query_text: 'b' });
    await service.createCheckoutSession(userId, 'http://localhost:3000');
    expect(gateway.checkoutCalls[0].quantity).toBe(2);
  });

  it('syncQuantity is a no-op without a subscription', async () => {
    await service.syncQuantity(userId);
    expect(gateway.quantityUpdates).toHaveLength(0);
  });

  it('syncQuantity pushes the active count and clamps to 1', async () => {
    await db.collection('users').updateOne({ _id: new ObjectId(userId) }, { $set: { stripe_subscription_id: 'sub_1' } });
    await service.syncQuantity(userId);
    expect(gateway.quantityUpdates).toEqual([{ subscriptionId: 'sub_1', quantity: 1 }]);

    await db.collection('queries').insertOne({ user_id: userId, query_text: 'a' });
    await service.syncQuantity(userId);
    expect(gateway.quantityUpdates).toEqual([
      { subscriptionId: 'sub_1', quantity: 1 },
      { subscriptionId: 'sub_1', quantity: 1 },
    ]);
  });

  it('processEvent on checkout.session.completed stores the subscription as active', async () => {
    await db.collection('users').updateOne({ _id: new ObjectId(userId) }, { $set: { stripe_customer_id: 'cus_test' } });
    await service.processEvent({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: { object: { customer: 'cus_test', subscription: 'sub_9', subscription_status: 'active' } },
    } as any);
    const row = await db.collection('users').findOne({ _id: new ObjectId(userId) });
    expect(row?.stripe_subscription_id).toBe('sub_9');
    expect(row?.stripe_subscription_status).toBe('active');
  });

  it('processEvent on customer.subscription.deleted clears the subscription', async () => {
    await db.collection('users').updateOne({ _id: new ObjectId(userId) }, {
      $set: { stripe_customer_id: 'cus_test', stripe_subscription_id: 'sub_9', stripe_subscription_status: 'active' },
    });
    await service.processEvent({
      id: 'evt_2',
      type: 'customer.subscription.deleted',
      data: { object: { customer: 'cus_test' } },
    } as any);
    const row = await db.collection('users').findOne({ _id: new ObjectId(userId) });
    expect(row?.stripe_subscription_id).toBeUndefined();
    expect(row?.stripe_subscription_status).toBeUndefined();
  });

  it('processEvent ignores a duplicate event id', async () => {
    const event = { id: 'evt_dup', type: 'checkout.session.completed', data: { object: { customer: 'cus_test', subscription: 'sub_1', subscription_status: 'active' } } } as any;
    await db.collection('users').updateOne({ _id: new ObjectId(userId) }, { $set: { stripe_customer_id: 'cus_test' } });
    await service.processEvent(event);
    await service.processEvent(event);
    const events = await db.collection('stripe_events').countDocuments({ _id: 'evt_dup' } as any);
    expect(events).toBe(1);
  });

  it('getStatus reports free-limit usage and subscription state', async () => {
    const free = await service.getStatus(userId);
    expect(free).toEqual({
      freeLimit: 1,
      activeQueryCount: 0,
      pricePerExtraQuery: 0.5,
      subscribed: false,
      subscriptionStatus: null,
      checkoutUrl: '/api/billing/checkout',
      portalUrl: '/api/billing/portal',
    });

    await db.collection('users').updateOne({ _id: new ObjectId(userId) }, {
      $set: { stripe_subscription_id: 'sub_1', stripe_subscription_status: 'active' },
    });
    const paid = await service.getStatus(userId);
    expect(paid.subscribed).toBe(true);
    expect(paid.subscriptionStatus).toBe('active');
  });
});
