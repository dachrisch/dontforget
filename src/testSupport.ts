import { MongoClient, type Db } from 'mongodb';
import { createClient } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createQuery, completeQueryRun } from './queries/queriesRepo.js';
import type { CandidateEvent, ExtractedEvent, RecurrenceInterval } from './types.js';

// Deliberately distinct from .env.example's DATABASE_URL (dev DB name
// "dontforget") — tests deleteMany() every collection in beforeEach, and
// sharing a DB name with local dev silently wipes dev data on `npm test`.
export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'mongodb://localhost:27017/dontforget-test';

const COLLECTIONS = ['users', 'magic_links', 'sessions', 'queries', 'events', 'feed_tokens', 'models', 'model_metrics', 'search_metrics'] as const;

export interface TestDb {
  client: MongoClient;
  db: Db;
}

// Test/seeding helper: creates a query and immediately lands a finished
// search on it, so suites can work with ready queries that already have
// candidate events (the production flow splits these two steps across the
// async POST + background run). Candidates come back in the same order the
// caller passed the events in — tests rely on that index correspondence.
export async function createQueryWithCandidates(
  db: Db,
  userId: string,
  queryText: string,
  events: ExtractedEvent[],
  recurrenceInterval?: RecurrenceInterval
): Promise<{ queryId: string; candidates: CandidateEvent[] }> {
  const query = await createQuery(db, userId, queryText, recurrenceInterval);
  const candidates = await completeQueryRun(db, query._id, events, null);
  return { queryId: query.queryId, candidates };
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
