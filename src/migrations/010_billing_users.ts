import type { Db } from 'mongodb';

export async function migrate(db: Db): Promise<void> {
  // The billing webhook looks users up by Stripe customer id, and event ids
  // dedupe Stripe's retried webhook deliveries. Fields themselves are written
  // by service code at use time (Mongo is schemaless) — only the indexes and
  // the idempotency collection live here.
  await db.collection('users').createIndex({ stripe_customer_id: 1 }, { unique: true, sparse: true });
  // This migration shipped once as 005_billing_users.ts (reverted in #119), so a
  // database that already ran it keeps its schema_migrations row but re-runs
  // this file under its new number — createCollection throws NamespaceExists if
  // the collection is already there, unlike createIndex which is idempotent.
  const existing = await db.listCollections({ name: 'stripe_events' }).toArray();
  if (existing.length === 0) {
    await db.createCollection('stripe_events');
  }
}
