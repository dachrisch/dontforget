import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../testSupport';
import { createQueryWithCandidates, listQueriesForUser, updateQuery } from './queriesRepo';
import { approveEvents } from './approveEvents';

describe('queries repo', () => {
  let client: MongoClient;
  let db: Db;
  let userId: string;

  beforeAll(async () => {
    ({ client, db } = await setupTestDb());
  });

  beforeEach(async () => {
    await cleanTestDb(db);
    const { insertedId } = await db.collection('users').insertOne({ email: 'd@example.com' });
    userId = insertedId.toString();
  });

  afterAll(async () => {
    await teardownTestDb(client);
  });

  describe('createQueryWithCandidates', () => {
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

    it('defaults to weekly and stamps the first run as the last run', async () => {
      const { queryId } = await createQueryWithCandidates(db, userId, 'Oktoberfest', []);

      const row = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });
      expect(row?.recurrence_interval).toBe('weekly');
      expect(row?.last_run_at).toBeInstanceOf(Date);
    });

    it('honours an explicit recurrence interval', async () => {
      const { queryId } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [], 'weekly');
      const row = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });
      expect(row?.recurrence_interval).toBe('weekly');
    });
  });

  describe('listQueriesForUser', () => {
    it('returns the user\u2019s queries newest-first with event counts and feed links once approved', async () => {
      const older = await createQueryWithCandidates(db, userId, 'Older query', [
        { label: 'Approved event', startDate: '2026-01-01', endDate: '2026-01-01', sourceUrl: 'u' },
      ]);
      const newer = await createQueryWithCandidates(
        db,
        userId,
        'Newer query',
        [
          { label: 'First', startDate: '2026-02-01', endDate: '2026-02-01', sourceUrl: 'u' },
          { label: 'Second', startDate: '2026-03-01', endDate: '2026-03-01', sourceUrl: 'u' },
        ],
        'quarterly'
      );
      await approveEvents(db, userId, older.queryId, [older.candidates[0].id], 'http://x');

      const dashboard = await listQueriesForUser(db, userId, 'http://localhost:3000');

      expect(dashboard.queries.map(q => q.id)).toEqual([newer.queryId, older.queryId]);
      expect(dashboard.queries[0]).toEqual({
        id: newer.queryId,
        text: 'Newer query',
        recurrenceInterval: 'quarterly',
        lastRunAt: expect.any(String),
        createdAt: expect.any(String),
        approvedCount: 0,
        candidateCount: 2,
      });
      expect(dashboard.queries[1].approvedCount).toBe(1);
      expect(dashboard.queries[1].candidateCount).toBe(0);
      expect(dashboard.queries[0].recurrenceInterval).toBe('quarterly');

      // Approving an event creates the feed token, so links show up already.
      expect(dashboard.feed).toEqual({
        icsUrl: expect.stringMatching(/^http:\/\/localhost:3000\/f\/.+\.ics$/),
        rssUrl: expect.stringMatching(/^http:\/\/localhost:3000\/f\/.+\.rss$/),
        lastFetchedAt: null,
      });
    });

    it('returns feed links and last fetched once a token exists', async () => {
      const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
        { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
      ]);
      await approveEvents(db, userId, queryId, [candidates[0].id], 'http://localhost:3000');
      const fetchedAt = new Date('2026-08-10T12:00:00Z');
      await db.collection('feed_tokens').updateOne({ user_id: userId }, { $set: { last_fetched_at: fetchedAt } });

      const dashboard = await listQueriesForUser(db, userId, 'http://localhost:3000');

      expect(dashboard.feed).toEqual({
        icsUrl: expect.stringMatching(/^http:\/\/localhost:3000\/f\/.+\.ics$/),
        rssUrl: expect.stringMatching(/^http:\/\/localhost:3000\/f\/.+\.rss$/),
        lastFetchedAt: '2026-08-10T12:00:00.000Z',
      });
    });

    it('does not mix one user\u2019s queries into another user\u2019s dashboard', async () => {
      await createQueryWithCandidates(db, userId, 'Mine', []);
      const { insertedId } = await db.collection('users').insertOne({ email: 'other@example.com' });
      await createQueryWithCandidates(db, insertedId.toString(), 'Not mine', []);

      const dashboard = await listQueriesForUser(db, userId, 'http://localhost:3000');
      expect(dashboard.queries).toHaveLength(1);
      expect(dashboard.queries[0].text).toBe('Mine');
      // No approval yet means no feed token, so no feed links to show.
      expect(dashboard.feed).toBeNull();
    });
  });

  describe('updateQuery', () => {
    it('updates text and recurrence interval and returns the refreshed summary', async () => {
      const { queryId } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', []);

      const updated = await updateQuery(db, userId, queryId, {
        text: 'Auer Dult Munich dates',
        recurrenceInterval: 'quarterly',
      });

      expect(updated).toMatchObject({
        id: queryId,
        text: 'Auer Dult Munich dates',
        recurrenceInterval: 'quarterly',
      });

      const row = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });
      expect(row?.query_text).toBe('Auer Dult Munich dates');
      expect(row?.recurrence_interval).toBe('quarterly');
    });

    it('allows updating just the schedule', async () => {
      const { queryId } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', []);
      const updated = await updateQuery(db, userId, queryId, { recurrenceInterval: 'yearly' });
      expect(updated?.text).toBe('Auer Dult Munich');
      expect(updated?.recurrenceInterval).toBe('yearly');
    });

    it('returns null for a query the user does not own', async () => {
      const { queryId } = await createQueryWithCandidates(db, userId, 'Mine', []);
      const { insertedId } = await db.collection('users').insertOne({ email: 'other@example.com' });
      const result = await updateQuery(db, insertedId.toString(), queryId, { text: 'hijack' });
      expect(result).toBeNull();
    });
  });
});