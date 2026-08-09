import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { createClient } from '../db/client';
import { runMigrations } from '../db/migrate';
import { createQueryWithCandidates } from './queriesRepo';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'mongodb://localhost:27017/dontforget';

describe('createQueryWithCandidates', () => {
  let client: MongoClient;
  let db: Db;
  let userId: string;

  beforeAll(async () => {
    client = await createClient(TEST_DB_URL);
    db = client.db();
    await runMigrations(db);
  });

  beforeEach(async () => {
    for (const name of ['users', 'magic_links', 'sessions', 'queries', 'events', 'feed_tokens']) {
      await db.collection(name).deleteMany({});
    }
    const { insertedId } = await db.collection('users').insertOne({ email: 'd@example.com' });
    userId = insertedId.toString();
  });

  afterAll(async () => {
    await client.close();
  });

  it('inserts the query and one candidate row per event', async () => {
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
      { label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'https://muenchen.de' },
    ]);

    expect(queryId).toBeTruthy();
    expect(candidates).toHaveLength(2);
    expect(candidates.every(c => c.status === 'candidate')).toBe(true);

    const stored = await db.collection('events').countDocuments({ query_id: new ObjectId(queryId) });
    expect(stored).toBe(2);
  });
});