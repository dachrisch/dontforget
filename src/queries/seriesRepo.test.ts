import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../testSupport';
import { createQuery, completeSeriesExpansion, listQueriesForUser } from './queriesRepo';
import { insertDiscoveredSeries, listSeriesForQuery, reviewSeries } from './seriesRepo';
import { MAX_SERIES } from '../search/opencodeClient';

function seriesFixture(n: number, prefix = 'Series') {
  return Array.from({ length: n }, (_, i) => ({
    title: `${prefix} ${i + 1}`,
    appliesTo: `${prefix} ${i + 1}, Munich`,
    description: `desc ${i + 1}`,
    searchKeywords: `${prefix} ${i + 1} Munich dates`,
    sourceUrls: [`https://example.com/${i + 1}`],
  }));
}

describe('series repo', () => {
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

  it('inserts discovered series as candidates, capped at MAX_SERIES', async () => {
    const { _id } = await createQuery(db, userId, 'events in munich');
    const inserted = await insertDiscoveredSeries(db, _id, userId, seriesFixture(MAX_SERIES + 5));

    expect(inserted).toHaveLength(MAX_SERIES);
    expect(inserted.every(s => s.status === 'candidate')).toBe(true);
    for (const s of inserted) {
      expect(s.title).toBeTruthy();
      expect(s.searchKeywords).toBeTruthy();
      expect(s.sourceUrls.length).toBeGreaterThan(0);
    }
    const rows = await db.collection('series').find({ query_id: _id }).toArray();
    expect(rows).toHaveLength(MAX_SERIES);
  });

  it('dedupes by normalized title and skips invalid entries', async () => {
    const { _id } = await createQuery(db, userId, 'events in munich');
    const inserted = await insertDiscoveredSeries(db, _id, userId, [
      { title: 'Oktoberfest', appliesTo: 'Oktoberfest, Munich', description: 'd', searchKeywords: 'Oktoberfest Munich', sourceUrls: ['https://a.example'] },
      { title: '  oktoberfest  ', appliesTo: 'Oktoberfest, Munich', description: 'dup', searchKeywords: 'Oktoberfest dup', sourceUrls: ['https://b.example'] },
      { title: '', appliesTo: '', description: 'no title', searchKeywords: 'x Munich', sourceUrls: ['https://a.example'] },
      { title: 'No keywords', appliesTo: 'No keywords, Munich', description: 'd', searchKeywords: '  ', sourceUrls: ['https://a.example'] },
      { title: 'No sources', appliesTo: 'No sources, Munich', description: 'd', searchKeywords: 'No sources Munich', sourceUrls: [] },
    ]);

    expect(inserted.map(s => s.title)).toEqual(['Oktoberfest']);
  });

  it('never re-creates a dismissed series on re-discovery', async () => {
    const { _id } = await createQuery(db, userId, 'events in munich');
    const [first] = await insertDiscoveredSeries(db, _id, userId, [
      { title: 'Oktoberfest', appliesTo: 'Oktoberfest, Munich', description: 'd', searchKeywords: 'Oktoberfest Munich', sourceUrls: ['https://a.example'] },
    ]);
    await reviewSeries(db, userId, _id.toString(), [], [first.id]);

    const second = await insertDiscoveredSeries(db, _id, userId, [
      { title: 'OKTOBERFEST', appliesTo: 'Oktoberfest, Munich', description: 'd', searchKeywords: 'Oktoberfest Munich', sourceUrls: ['https://a.example'] },
      { title: 'Auer Dult', appliesTo: 'Auer Dult, Munich', description: 'd', searchKeywords: 'Auer Dult Munich', sourceUrls: ['https://b.example'] },
    ]);

    expect(second.map(s => s.title)).toEqual(['Auer Dult']);
    const rows = await db.collection('series').find({ query_id: _id }).toArray();
    expect(rows).toHaveLength(2);
  });

  it('reviews series with dismiss winning on overlap, scoped to the owner', async () => {
    const { _id } = await createQuery(db, userId, 'events in munich');
    const inserted = await insertDiscoveredSeries(db, _id, userId, seriesFixture(2));
    const updated = await reviewSeries(
      db,
      userId,
      _id.toString(),
      [inserted[0].id, inserted[1].id],
      [inserted[1].id]
    );

    expect(updated?.map(s => s.status)).toEqual(['approved', 'dismissed']);

    const { insertedId: otherId } = await db.collection('users').insertOne({ email: 'other@example.com' });
    const foreign = await reviewSeries(db, otherId.toString(), _id.toString(), [inserted[0].id]);
    expect(foreign).toBeNull();
  });

  it('expands an approved series into dated events linked via series_id', async () => {
    const { _id } = await createQuery(db, userId, 'events in munich');
    const [series] = await insertDiscoveredSeries(db, _id, userId, [
      { title: 'Auer Dult', appliesTo: 'Auer Dult, Munich', description: 'd', searchKeywords: 'Auer Dult Munich dates', sourceUrls: ['https://a.example'] },
    ]);
    await reviewSeries(db, userId, _id.toString(), [series.id]);

    const inserted = await completeSeriesExpansion(db, _id, new ObjectId(series.id), [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://a.example' },
    ]);

    expect(inserted).toHaveLength(1);
    expect(inserted[0].seriesId).toBe(series.id);
    // Approved series is trusted: lands as approved without re-approval.
    expect(inserted[0].status).toBe('approved');

    const row = await db.collection('events').findOne({ query_id: _id });
    expect(row?.series_id?.toString()).toBe(series.id);
    expect(row?.query_id.toString()).toBe(_id.toString());
  });

  it('lands candidate events for a non-approved series when the query is untrusted', async () => {
    const { _id } = await createQuery(db, userId, 'events in munich');
    const [series] = await insertDiscoveredSeries(db, _id, userId, [
      { title: 'Auer Dult', appliesTo: 'Auer Dult, Munich', description: 'd', searchKeywords: 'Auer Dult Munich dates', sourceUrls: ['https://a.example'] },
    ]);

    const inserted = await completeSeriesExpansion(db, _id, new ObjectId(series.id), [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://a.example' },
    ]);

    expect(inserted[0].status).toBe('candidate');
  });

  it('does not reinsert a date that already exists for the series', async () => {
    const { _id } = await createQuery(db, userId, 'events in munich');
    const [series] = await insertDiscoveredSeries(db, _id, userId, [
      { title: 'Auer Dult', appliesTo: 'Auer Dult, Munich', description: 'd', searchKeywords: 'Auer Dult Munich dates', sourceUrls: ['https://a.example'] },
    ]);
    await reviewSeries(db, userId, _id.toString(), [series.id]);
    const seriesObjectId = new ObjectId(series.id);
    await completeSeriesExpansion(db, _id, seriesObjectId, [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://a.example' },
    ]);
    const second = await completeSeriesExpansion(db, _id, seriesObjectId, [
      { label: 'Frühjahrsdult again', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://b.example' },
    ]);

    expect(second).toHaveLength(0);
    const rows = await db.collection('events').find({ query_id: _id }).toArray();
    expect(rows).toHaveLength(1);
  });

  it('nests series with event counts under the parent query in the dashboard', async () => {
    const { _id } = await createQuery(db, userId, 'events in munich');
    const [series] = await insertDiscoveredSeries(db, _id, userId, [
      { title: 'Auer Dult', appliesTo: 'Auer Dult, Munich', description: 'fair', searchKeywords: 'Auer Dult Munich', sourceUrls: ['https://a.example'] },
    ]);
    await reviewSeries(db, userId, _id.toString(), [series.id]);
    await completeSeriesExpansion(db, _id, new ObjectId(series.id), [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://a.example' },
    ]);

    const dashboard = await listQueriesForUser(db, userId, 'http://localhost:3000');
    expect(dashboard.queries).toHaveLength(1);
    expect(dashboard.queries[0].approvedCount).toBe(1);
    expect(dashboard.queries[0].series).toHaveLength(1);
    expect(dashboard.queries[0].series?.[0]).toMatchObject({
      id: series.id,
      title: 'Auer Dult',
      status: 'approved',
      eventCounts: { approved: 1, candidate: 0 },
    });
  });

  it('returns null series for a query the user does not own', async () => {
    const { _id } = await createQuery(db, userId, 'events in munich');
    const { insertedId: otherId } = await db.collection('users').insertOne({ email: 'other@example.com' });
    const result = await listSeriesForQuery(db, otherId.toString(), _id.toString());
    expect(result).toBeNull();
  });

  it('stores what each series applies to and exposes it', async () => {
    const { _id } = await createQuery(db, userId, 'Stadtfest Minden');
    const [series] = await insertDiscoveredSeries(db, _id, userId, [
      { title: 'Stadtfest Minden', appliesTo: 'Stadtfest Minden, Minden', description: 'annual city festival', searchKeywords: 'Stadtfest Minden Termine', sourceUrls: ['https://a.example'] },
    ]);

    expect(series.appliesTo).toBe('Stadtfest Minden, Minden');
    const row = await db.collection('series').findOne({ query_id: _id });
    expect(row?.applies_to).toBe('Stadtfest Minden, Minden');
  });

  it('dedupes by what the series applies to, not the display title', async () => {
    const { _id } = await createQuery(db, userId, 'events in munich');
    const inserted = await insertDiscoveredSeries(db, _id, userId, [
      { title: 'Auer Dult — Spring', appliesTo: 'Auer Dult, Munich', description: 'd', searchKeywords: 'Auer Dult Munich', sourceUrls: ['https://a.example'] },
      { title: 'Auer Dult — Summer', appliesTo: 'Auer Dult, Munich', description: 'd', searchKeywords: 'Auer Dult Munich', sourceUrls: ['https://b.example'] },
    ]);

    expect(inserted).toHaveLength(1);
  });

  it('approving a series subscribes its existing candidate events', async () => {
    const { _id } = await createQuery(db, userId, 'events in munich');
    const [series] = await insertDiscoveredSeries(db, _id, userId, [
      { title: 'Auer Dult', appliesTo: 'Auer Dult, Munich', description: 'd', searchKeywords: 'Auer Dult Munich dates', sourceUrls: ['https://a.example'] },
    ]);
    await completeSeriesExpansion(db, _id, new ObjectId(series.id), [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://a.example' },
    ]);

    await reviewSeries(db, userId, _id.toString(), [series.id]);

    const row = await db.collection('events').findOne({ query_id: _id });
    expect(row?.status).toBe('approved');
  });

  it('dismissing a series unsubscribes its events so they never reach the feed', async () => {
    const { _id } = await createQuery(db, userId, 'events in munich');
    const [series] = await insertDiscoveredSeries(db, _id, userId, [
      { title: 'Auer Dult', appliesTo: 'Auer Dult, Munich', description: 'd', searchKeywords: 'Auer Dult Munich dates', sourceUrls: ['https://a.example'] },
    ]);
    await reviewSeries(db, userId, _id.toString(), [series.id]);
    await completeSeriesExpansion(db, _id, new ObjectId(series.id), [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://a.example' },
    ]);

    await reviewSeries(db, userId, _id.toString(), [], [series.id]);

    const row = await db.collection('events').findOne({ query_id: _id });
    expect(row?.status).toBe('dismissed');
  });

  it('keeps the same calendar date for two different subscribed series', async () => {
    const { _id } = await createQuery(db, userId, 'events in munich');
    const [first, second] = await insertDiscoveredSeries(db, _id, userId, [
      { title: 'Auer Dult', appliesTo: 'Auer Dult, Munich', description: 'd', searchKeywords: 'Auer Dult Munich', sourceUrls: ['https://a.example'] },
      { title: 'Oktoberfest', appliesTo: 'Oktoberfest, Munich', description: 'd', searchKeywords: 'Oktoberfest Munich', sourceUrls: ['https://b.example'] },
    ]);
    await reviewSeries(db, userId, _id.toString(), [first.id, second.id]);

    const date = { label: 'Shared date', startDate: '2026-09-19', endDate: '2026-09-19', sourceUrl: 'https://a.example' };
    const firstInsert = await completeSeriesExpansion(db, _id, new ObjectId(first.id), [date]);
    const secondInsert = await completeSeriesExpansion(db, _id, new ObjectId(second.id), [date]);

    expect(firstInsert).toHaveLength(1);
    expect(secondInsert).toHaveLength(1);
  });
});
