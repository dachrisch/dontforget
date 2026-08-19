import type { Db } from 'mongodb';

export async function migrate(db: Db): Promise<void> {
  // The billing webhook looks users up by Stripe customer id, and event ids
  // dedupe Stripe's retried webhook deliveries. Fields themselves are written
  // by service code at use time (Mongo is schemaless) — only the indexes and
  // the idempotency collection live here.
  await db.collection('users').createIndex({ stripe_customer_id: 1 }, { unique: true, sparse: true });
  await db.createCollection('stripe_events');
}
