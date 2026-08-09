import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../testSupport';
import { createQueryWithCandidates } from './queriesRepo';
import { approveEvents } from './approveEvents';

describe('approveEvents', () => {
  let client: MongoClient;
  let db: Db;
  let userId: string;

  beforeAll(async () => {
    ({ client, db } = await setupTestDb());
  });

  beforeEach(async () => {
    await cleanTestDb(db);
    const { insertedId } = await db.collection('users').insertOne({ email: 'f@example.com' });
    userId = insertedId.toString();
  });

  afterAll(async () => {
    await teardownTestDb(client);
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
      .toArray();
    const byLabel = Object.fromEntries(statuses.map(r => [r.label as string, r.status as string]));
    expect(byLabel['Frühjahrsdult']).toBe('approved');
    expect(byLabel['Kirchweihdult (stale)']).toBe('candidate');
  });

  it('returns null for a query the user does not own', async () => {
    const { insertedId } = await db.collection('users').insertOne({ email: 'g@example.com' });
    const otherUserId = insertedId.toString();
    const { queryId } = await createQueryWithCandidates(db, otherUserId, 'Not yours', []);

    const result = await approveEvents(db, userId, queryId, [], 'http://localhost:3000');
    expect(result).toBeNull();
  });

  it('returns null instead of throwing for a malformed query id', async () => {
    const result = await approveEvents(db, userId, 'not-a-real-id', [], 'http://localhost:3000');
    expect(result).toBeNull();
  });

  it('ignores malformed event ids instead of throwing', async () => {
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
    ]);

    const result = await approveEvents(
      db,
      userId,
      queryId,
      [candidates[0].id, 'not-a-real-id'],
      'http://localhost:3000'
    );

    expect(result).not.toBeNull();
    const stored = await db.collection('events').findOne({ query_id: new ObjectId(queryId) });
    expect(stored!.status).toBe('approved');
  });
});