import { MongoClient, type Db } from 'mongodb';
import { createClient } from './db/client.js';
import { runMigrations } from './db/migrate.js';

// Deliberately distinct from .env.example's DATABASE_URL (dev DB name
// "dontforget") — tests deleteMany() every collection in beforeEach, and
// sharing a DB name with local dev silently wipes dev data on `npm test`.
export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'mongodb://localhost:27017/dontforget-test';

const COLLECTIONS = ['users', 'magic_links', 'sessions', 'queries', 'events', 'feed_tokens'] as const;

export interface TestDb {
  client: MongoClient;
  db: Db;
}

export async function setupTestDb(): Promise<TestDb> {
  const client = await createClient(TEST_DB_URL);
  const db = client.db();
  await runMigrations(db);
  return { client, db };
}

export async function cleanTestDb(db: Db): Promise<void> {
  for (const name of COLLECTIONS) {
    await db.collection(name).deleteMany({});
  }
}

export async function teardownTestDb(client: MongoClient): Promise<void> {
  await client.close();
}
