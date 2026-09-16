import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { setupTestDb, cleanTestDb, teardownTestDb, createQueryWithCandidates } from '../testSupport';
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

  it('merges a re-discovered dismissed series in place instead of re-creating it', async () => {
    const { _id } = await createQuery(db, userId, 'events in munich');
    const [first] = await insertDiscoveredSeries(db, _id, userId, [
      { title: 'Oktoberfest', appliesTo: 'Oktoberfest, Munich', description: 'd', searchKeywords: 'Oktoberfest Munich', sourceUrls: ['https://a.example'] },
    ]);
    await reviewSeries(db, userId, _id.toString(), [], [first.id]);

    const second = await insertDiscoveredSeries(db, _id, userId, [
      { title: 'OKTOBERFEST', appliesTo: 'Oktoberfest, Munich', description: 'updated', searchKeywords: 'Oktoberfest Munich 2027', sourceUrls: ['https://b.example'] },
      { title: 'Auer Dult', appliesTo: 'Auer Dult, Munich', description: 'd', searchKeywords: 'Auer Dult Munich', sourceUrls: ['https://c.example'] },
    ]);

    // The dismissed row is merged in place — no twin, no re-creation — and
    // is returned as an updated row alongside the genuine new discovery.
    expect(second).toHaveLength(2);
    expect(second[0]).toMatchObject({ id: first.id, status: 'dismissed', description: 'updated', searchKeywords: 'Oktoberfest Munich 2027' });
    expect(second[1].title).toBe('Auer Dult');
    const rows = await db.collection('series').find({ query_id: _id }).toArray();
    expect(rows).toHaveLength(2);
  });

  it('normalizes parenthetical qualifiers so identity drift never spawns twins', async () => {
    const { _id } = await createQuery(db, userId, 'Stadtfest Minden');
    const [first] = await insertDiscoveredSeries(db, _id, userId, [
      { title: 'Stadtfest Minden', appliesTo: 'Stadtfest Minden, Minden (Westfalen)', description: 'd', searchKeywords: 'Stadtfest Minden Termine', sourceUrls: ['https://a.example'] },
    ]);
    await reviewSeries(db, userId, _id.toString(), [first.id]);

    const rediscovered = await insertDiscoveredSeries(db, _id, userId, [
      { title: 'Stadtfest Minden', appliesTo: 'Stadtfest Minden, Minden', description: 'refreshed', searchKeywords: 'Stadtfest Minden 2027 Termine', sourceUrls: ['https://b.example'] },
    ]);

    expect(rediscovered).toHaveLength(1);
    expect(rediscovered[0]).toMatchObject({ id: first.id, status: 'approved', description: 'refreshed' });
    const rows = await db.collection('series').find({ query_id: _id }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('approved');
  });

  it('keeps a learned cadence and title when merging a re-discovered series', async () => {
    const { _id } = await createQuery(db, userId, 'Stadtfest Minden');
    const [first] = await insertDiscoveredSeries(db, _id, userId, [
      { title: 'Stadtfest Minden', appliesTo: 'Stadtfest Minden, Minden', description: 'd', searchKeywords: 'Stadtfest Minden Termine', sourceUrls: ['https://a.example'] },
    ]);
    await db.collection('series').updateOne({ _id: new ObjectId(first.id) }, { $set: { cadence: 'yearly' } });

    const rediscovered = await insertDiscoveredSeries(db, _id, userId, [
      { title: 'Mindener Stadtfest', appliesTo: 'Stadtfest Minden, Minden (Westfalen)', description: 'refreshed', searchKeywords: 'Stadtfest Minden 2027 Termine', sourceUrls: ['https://b.example'] },
    ]);

    const row = await db.collection('series').findOne({ _id: new ObjectId(first.id) });
    expect(row).toMatchObject({ status: 'candidate', cadence: 'yearly', description: 'refreshed' });
    expect(rediscovered[0]).toMatchObject({ id: first.id, cadence: 'yearly' });
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

  it('persists the judged series cadence even when zero events were found (issue #199)', async () => {
    const { _id } = await createQuery(db, userId, 'Stadtfest Minden');
    const [series] = await insertDiscoveredSeries(db, _id, userId, [
      { title: 'Stadtfest Minden', appliesTo: 'Stadtfest Minden, Minden', description: 'annual city festival', searchKeywords: 'Stadtfest Minden Termine', sourceUrls: ['https://a.example'] },
    ]);
    await reviewSeries(db, userId, _id.toString(), [series.id]);

    // Annual festival outside the weekly window: no dates, but the model
    // still judges the series cadence — that must be stored so the next
    // lookup widens its window.
    const inserted = await completeSeriesExpansion(db, _id, new ObjectId(series.id), [], 'yearly');
    expect(inserted).toHaveLength(0);

    const row = await db.collection('series').findOne({ _id: new ObjectId(series.id) });
    expect(row?.cadence).toBe('yearly');

    const listed = await listSeriesForQuery(db, userId, _id.toString());
    expect(listed?.[0]).toMatchObject({ id: series.id, cadence: 'yearly' });
  });

  it('leaves a previously learned cadence untouched when an expansion reports null', async () => {
    const { _id } = await createQuery(db, userId, 'Stadtfest Minden');
    const [series] = await insertDiscoveredSeries(db, _id, userId, [
      { title: 'Stadtfest Minden', appliesTo: 'Stadtfest Minden, Minden', description: 'annual city festival', searchKeywords: 'Stadtfest Minden Termine', sourceUrls: ['https://a.example'] },
    ]);
    await db.collection('series').updateOne({ _id: new ObjectId(series.id) }, { $set: { cadence: 'yearly' } });

    await completeSeriesExpansion(
      db,
      _id,
      new ObjectId(series.id),
      [{ label: 'Stadtfest Minden 2026', startDate: '2026-06-12', endDate: '2026-06-14', sourceUrl: 'https://a.example' }],
      null
    );

    const row = await db.collection('series').findOne({ _id: new ObjectId(series.id) });
    expect(row?.cadence).toBe('yearly');
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

  it('keeps a candidate series untrusted even when other events are approved', async () => {
    // Strict per-series trust: a legacy approved event elsewhere in the
    // query must not auto-approve a new, unsubscribed series' dates.
    const { approveEvents } = await import('./approveEvents');
    const legacy = await createQueryWithCandidates(db, userId, 'events in munich', [
      { label: 'Legacy approved', startDate: '2026-01-01', endDate: '2026-01-01', sourceUrl: 'https://a.example' },
    ]);
    await approveEvents(db, userId, legacy.queryId, [legacy.candidates[0].id], 'http://localhost:3000');
    const queryObjectId = new ObjectId(legacy.queryId);
    const [series] = await insertDiscoveredSeries(db, queryObjectId, userId, [
      { title: 'Auer Dult', appliesTo: 'Auer Dult, Munich', description: 'd', searchKeywords: 'Auer Dult Munich dates', sourceUrls: ['https://a.example'] },
    ]);

    const inserted = await completeSeriesExpansion(db, queryObjectId, new ObjectId(series.id), [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://a.example' },
    ]);

    expect(inserted).toHaveLength(1);
    expect(inserted[0].status).toBe('candidate');
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
