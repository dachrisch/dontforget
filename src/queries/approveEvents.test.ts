import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { setupTestDb, cleanTestDb, teardownTestDb, createQueryWithCandidates } from '../testSupport';
import { approveEvents } from './approveEvents';
import { createQuery, completeSeriesExpansion } from './queriesRepo';
import { insertDiscoveredSeries } from './seriesRepo';

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

  it('dismisses only the selected events, leaving others untouched', async () => {
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
      { label: 'Kirchweihdult (stale)', startDate: '2024-10-20', endDate: '2024-10-29', sourceUrl: 'https://eventbrite.com' },
    ]);

    const result = await approveEvents(db, userId, queryId, [], 'http://localhost:3000', undefined, [candidates[1].id]);

    expect(result).not.toBeNull();
    const statuses = await db
      .collection('events')
      .find({ query_id: new ObjectId(queryId) })
      .toArray();
    const byLabel = Object.fromEntries(statuses.map(r => [r.label as string, r.status as string]));
    expect(byLabel['Frühjahrsdult']).toBe('candidate');
    expect(byLabel['Kirchweihdult (stale)']).toBe('dismissed');
  });

  it('subscribes to the parent series when approving its dates', async () => {
    const query = await createQuery(db, userId, 'events in munich');
    const [series] = await insertDiscoveredSeries(db, query._id, userId, [
      { title: 'Auer Dult', appliesTo: 'Auer Dult, Munich', description: 'd', searchKeywords: 'Auer Dult Munich dates', sourceUrls: ['https://a.example'] },
    ]);
    const inserted = await completeSeriesExpansion(db, query._id, new ObjectId(series.id), [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://a.example' },
    ]);

    await approveEvents(db, userId, query.queryId, [inserted[0].id], 'http://localhost:3000');

    const row = await db.collection('series').findOne({ _id: new ObjectId(series.id) });
    expect(row?.status).toBe('approved');
  });

  it('does not subscribe to the parent series for dismissed dates', async () => {
    const query = await createQuery(db, userId, 'events in munich');
    const [series] = await insertDiscoveredSeries(db, query._id, userId, [
      { title: 'Auer Dult', appliesTo: 'Auer Dult, Munich', description: 'd', searchKeywords: 'Auer Dult Munich dates', sourceUrls: ['https://a.example'] },
    ]);
    const inserted = await completeSeriesExpansion(db, query._id, new ObjectId(series.id), [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://a.example' },
    ]);

    await approveEvents(db, userId, query.queryId, [], 'http://localhost:3000', undefined, [inserted[0].id]);

    const row = await db.collection('series').findOne({ _id: new ObjectId(series.id) });
    expect(row?.status).toBe('candidate');
  });

  it('approves and dismisses different events in the same call', async () => {
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
      { label: 'Kirchweihdult (stale)', startDate: '2024-10-20', endDate: '2024-10-29', sourceUrl: 'https://eventbrite.com' },
    ]);

    await approveEvents(
      db,
      userId,
      queryId,
      [candidates[0].id],
      'http://localhost:3000',
      undefined,
      [candidates[1].id]
    );

    const statuses = await db
      .collection('events')
      .find({ query_id: new ObjectId(queryId) })
      .toArray();
    const byLabel = Object.fromEntries(statuses.map(r => [r.label as string, r.status as string]));
    expect(byLabel['Frühjahrsdult']).toBe('approved');
    expect(byLabel['Kirchweihdult (stale)']).toBe('dismissed');
  });
});