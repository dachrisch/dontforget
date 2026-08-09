import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { createClient } from '../db/client';
import { runMigrations } from '../db/migrate';
import { createQueryWithCandidates } from './queriesRepo';
import { approveEvents } from './approveEvents';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'mongodb://localhost:27017/dontforget';

describe('approveEvents', () => {
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
    const { insertedId } = await db.collection('users').insertOne({ email: 'f@example.com' });
    userId = insertedId.toString();
  });

  afterAll(async () => {
    await client.close();
  });

  it('approves only the selected events and returns feed URLs', async () => {
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
      { label: 'Kirchweihdult (stale)', startDate: '2024-10-20', endDate: '2024-10-29', sourceUrl: 'https://eventbrite.com' },
    ]);

    const result = await approveEvents(
      db,
      userId,
      queryId,
      [candidates[0].id],
      'http://localhost:3000'
    );

    expect(result).not.toBeNull();
    expect(result!.icsUrl).toMatch(/^http:\/\/localhost:3000\/f\/.+\.ics$/);
    expect(result!.rssUrl).toMatch(/^http:\/\/localhost:3000\/f\/.+\.rss$/);

    const statuses = await db
      .collection('events')
      .find({ query_id: new ObjectId(queryId) })
      .sort({ start_date: 1 })
      .toArray();
    expect(statuses.map(r => r.status)).toEqual(['approved', 'candidate']);
  });

  it('returns null for a query the user does not own', async () => {
    const { insertedId } = await db.collection('users').insertOne({ email: 'g@example.com' });
    const otherUserId = insertedId.toString();
    const { queryId } = await createQueryWithCandidates(db, otherUserId, 'Not yours', []);

    const result = await approveEvents(db, userId, queryId, [], 'http://localhost:3000');
    expect(result).toBeNull();
  });
});