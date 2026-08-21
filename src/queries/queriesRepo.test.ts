import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../testSupport';
import { createQuery, completeQueryRun, listQueriesForUser, updateQuery, markQueryFailed, deleteQuery } from './queriesRepo';
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

  describe('createQuery', () => {
    it('inserts a running query with the first run stamped and returns the id', async () => {
      const query = await createQuery(db, userId, 'Auer Dult Munich');

      expect(query.queryId).toBeTruthy();
      const row = await db.collection('queries').findOne({ _id: query._id });
      expect(row?.recurrence_interval).toBe('weekly');
      expect(row?.status).toBe('running');
      expect(row?.last_run_at).toBeInstanceOf(Date);
    });

    it('defaults to weekly and honours an explicit recurrence interval', async () => {
      const { queryId: defaultQuery } = await createQuery(db, userId, 'Oktoberfest');
      const defaultRow = await db.collection('queries').findOne({ _id: new ObjectId(defaultQuery) });
      expect(defaultRow?.recurrence_interval).toBe('weekly');

      const { queryId: explicitQuery } = await createQuery(db, userId, 'Auer Dult Munich', 'quarterly');
      const explicitRow = await db.collection('queries').findOne({ _id: new ObjectId(explicitQuery) });
      expect(explicitRow?.recurrence_interval).toBe('quarterly');
    });
  });

  describe('completeQueryRun', () => {
    it('inserts one candidate row per event, marks the query ready, and applies the cadence', async () => {
      const query = await createQuery(db, userId, 'Auer Dult Munich');
      await completeQueryRun(db, query._id, [
        { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
        { label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'https://muenchen.de' },
      ], 'yearly');

      const stored = await db.collection('events').find({ query_id: query._id }).toArray();
      expect(stored).toHaveLength(2);
      expect(stored.every(e => e.status === 'candidate')).toBe(true);

      const row = await db.collection('queries').findOne({ _id: query._id });
      expect(row?.status).toBe('ready');
      expect(row?.recurrence_interval).toBe('yearly');
      expect(row?.last_run_at).toBeInstanceOf(Date);
    });

    it('does not override the cadence when none is suggested', async () => {
      const query = await createQuery(db, userId, 'Oktoberfest', 'weekly');
      await completeQueryRun(db, query._id, [], null);
      const row = await db.collection('queries').findOne({ _id: query._id });
      expect(row?.status).toBe('ready');
      expect(row?.recurrence_interval).toBe('weekly');
    });

    it('does not reinsert a dismissed event when the same date is found again', async () => {
      const query = await createQuery(db, userId, 'Auer Dult Munich');
      const [candidate] = await completeQueryRun(db, query._id, [
        { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
      ], null);
      await approveEvents(db, userId, query.queryId, [], 'http://localhost:3000', undefined, [candidate.id]);

      await completeQueryRun(db, query._id, [
        { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
      ], null);

      const stored = await db.collection('events').find({ query_id: query._id }).toArray();
      expect(stored).toHaveLength(1);
      expect(stored[0].status).toBe('dismissed');
    });
  });

  describe('markQueryFailed', () => {
    it('flips a query to failed', async () => {
      const { _id } = await createQuery(db, userId, 'Oktoberfest');
      await markQueryFailed(db, _id);
      const row = await db.collection('queries').findOne({ _id });
      expect(row?.status).toBe('failed');
    });
  });

  describe('listQueriesForUser', () => {
    it('returns the user’s queries newest-first with event counts, status, and feed links once approved', async () => {
      const older = await createQuery(db, userId, 'Older query');
      await completeQueryRun(db, older._id, [
        { label: 'Approved event', startDate: '2026-01-01', endDate: '2026-01-01', sourceUrl: 'u' },
      ], null);
      const newer = await createQuery(db, userId, 'Newer query', 'quarterly');
      await completeQueryRun(db, newer._id, [
        { label: 'First', startDate: '2026-02-01', endDate: '2026-02-01', sourceUrl: 'u' },
        { label: 'Second', startDate: '2026-03-01', endDate: '2026-03-01', sourceUrl: 'u' },
      ], null);

      const olderEvents = (await db.collection('events').find({ query_id: older._id }).toArray());
      await approveEvents(db, userId, older.queryId, [olderEvents[0]._id.toString()], 'http://x');

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
        status: 'ready',
        active: true,
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

    it('exposes a query stuck in a search as running', async () => {
      const query = await createQuery(db, userId, 'Running query');
      const dashboard = await listQueriesForUser(db, userId, 'http://localhost:3000');
      expect(dashboard.queries[0]).toMatchObject({ id: query.queryId, status: 'running', candidateCount: 0 });
    });

    it('returns feed links and last fetched once a token exists', async () => {
      const query = await createQuery(db, userId, 'Auer Dult Munich');
      await completeQueryRun(db, query._id, [
        { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
      ], null);
      const events = (await db.collection('events').find({ query_id: query._id }).toArray());
      await approveEvents(db, userId, query.queryId, [events[0]._id.toString()], 'http://localhost:3000');
      const fetchedAt = new Date('2026-08-10T12:00:00Z');
      await db.collection('feed_tokens').updateOne({ user_id: userId }, { $set: { last_fetched_at: fetchedAt } });

      const dashboard = await listQueriesForUser(db, userId, 'http://localhost:3000');

      expect(dashboard.feed).toEqual({
        icsUrl: expect.stringMatching(/^http:\/\/localhost:3000\/f\/.+\.ics$/),
        rssUrl: expect.stringMatching(/^http:\/\/localhost:3000\/f\/.+\.rss$/),
        lastFetchedAt: '2026-08-10T12:00:00.000Z',
      });
    });

    it('does not mix one user’s queries into another user’s dashboard', async () => {
      await createQuery(db, userId, 'Mine');
      const { insertedId } = await db.collection('users').insertOne({ email: 'other@example.com' });
      await createQuery(db, insertedId.toString(), 'Not mine');

      const dashboard = await listQueriesForUser(db, userId, 'http://localhost:3000');
      expect(dashboard.queries).toHaveLength(1);
      expect(dashboard.queries[0].text).toBe('Mine');
      // No approval yet means no feed token, so no feed links to show.
      expect(dashboard.feed).toBeNull();
    });
  });

  describe('updateQuery', () => {
    it('updates text and recurrence interval and returns the refreshed summary', async () => {
      const query = await createQuery(db, userId, 'Auer Dult Munich');
      await completeQueryRun(db, query._id, [], null);

      const updated = await updateQuery(db, userId, query.queryId, {
        text: 'Auer Dult Munich dates',
        recurrenceInterval: 'quarterly',
      });

      expect(updated).toMatchObject({
        id: query.queryId,
        text: 'Auer Dult Munich dates',
        recurrenceInterval: 'quarterly',
        status: 'ready',
      });

      const row = await db.collection('queries').findOne({ _id: query._id });
      expect(row?.query_text).toBe('Auer Dult Munich dates');
      expect(row?.recurrence_interval).toBe('quarterly');
    });

    it('allows updating just the schedule', async () => {
      const query = await createQuery(db, userId, 'Auer Dult Munich');
      const updated = await updateQuery(db, userId, query.queryId, { recurrenceInterval: 'yearly' });
      expect(updated?.text).toBe('Auer Dult Munich');
      expect(updated?.recurrenceInterval).toBe('yearly');
    });

    it('returns null for a query the user does not own', async () => {
      const query = await createQuery(db, userId, 'Mine');
      const { insertedId } = await db.collection('users').insertOne({ email: 'other@example.com' });
      const result = await updateQuery(db, insertedId.toString(), query.queryId, { text: 'hijack' });
      expect(result).toBeNull();
    });
  });

  describe('deleteQuery', () => {
    it('returns null for a nonexistent id', async () => {
      expect(await deleteQuery(db, userId, new ObjectId().toString())).toBeNull();
    });

    it('returns null for a query the user does not own', async () => {
      const query = await createQuery(db, userId, 'Mine');
      const { insertedId } = await db.collection('users').insertOne({ email: 'other@example.com' });
      expect(await deleteQuery(db, insertedId.toString(), query.queryId)).toBeNull();
      // not actually deleted
      expect(await db.collection('queries').countDocuments({ _id: query._id })).toBe(1);
    });

    it('reports active: true and removes the row plus its events for a normal active query', async () => {
      const query = await createQuery(db, userId, 'Auer Dult Munich');
      await completeQueryRun(db, query._id, [
        { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
      ]);

      const result = await deleteQuery(db, userId, query.queryId);

      expect(result).toEqual({ active: true });
      expect(await db.collection('queries').countDocuments({ _id: query._id })).toBe(0);
      expect(await db.collection('events').countDocuments({ query_id: query._id })).toBe(0);
    });

    it('reports active: false for a blocked query — it never held a slot', async () => {
      const query = await createQuery(db, userId, 'Auer Dult Munich', 'weekly', false);
      const result = await deleteQuery(db, userId, query.queryId);
      expect(result).toEqual({ active: false });
    });

    it('reports active: false for a paused query', async () => {
      const query = await createQuery(db, userId, 'Auer Dult Munich');
      await db.collection('queries').updateOne({ _id: query._id }, { $set: { active: false } });
      const result = await deleteQuery(db, userId, query.queryId);
      expect(result).toEqual({ active: false });
    });

    it('treats a legacy row with no active field as active', async () => {
      const { insertedId } = await db.collection('queries').insertOne({
        user_id: userId,
        query_text: 'legacy',
        created_at: new Date(),
      });
      const result = await deleteQuery(db, userId, insertedId.toString());
      expect(result).toEqual({ active: true });
    });
  });
});