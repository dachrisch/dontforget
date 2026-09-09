import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../testSupport';
import { createQuery } from './queriesRepo';
import { runInitialQuery } from './initialRun';
import { createSearchOrchestrator, createSeriesDiscoveryOrchestrator } from '../search/searchOrchestrator';

// Two-stage pipeline acceptance coverage (issue #143) with mocked
// searxng + opencode: broad queries yield bounded series and zero dated
// events before approval; per-series expansion reuses the existing
// single-stage path and links events via series_id.
describe('two-stage series pipeline', () => {
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

  function discoveryDeps(series: Array<{ title: string; appliesTo?: string; searchKeywords: string }>) {
    const searxngSearch = vi.fn().mockResolvedValue([{ title: 't', url: 'u', content: 'c' }]);
    const extractSeries = vi.fn().mockResolvedValue({
      series: series.map((s, i) => ({
        title: s.title,
        appliesTo: s.appliesTo ?? `${s.title}, Munich`,
        description: `desc ${i}`,
        searchKeywords: s.searchKeywords,
        sourceUrls: [`https://example.com/${i}`],
      })),
    });
    return { searxngSearch, extractSeries, discoverSeries: createSeriesDiscoveryOrchestrator({ searxngSearch, extractSeries }) };
  }

  it('broad query yields 1 query + bounded series candidates and zero dated events before approval', async () => {
    const query = await createQuery(db, userId, 'events in munich');
    const { searxngSearch, extractSeries, discoverSeries } = discoveryDeps([
      { title: 'Oktoberfest', searchKeywords: 'Oktoberfest Munich dates' },
      { title: 'Auer Dult', searchKeywords: 'Auer Dult Munich dates' },
      { title: 'FC Bayern home matches', searchKeywords: 'FC Bayern home matches Munich dates' },
      { title: 'Munich Opera season', searchKeywords: 'Munich Opera season dates' },
    ]);

    await runInitialQuery(db, query, { runQuery: vi.fn(), discoverSeries, applyCadence: false, userId });

    // Cost guardrail: exactly 1 discovery searxng + 1 discovery opencode call.
    expect(searxngSearch).toHaveBeenCalledTimes(1);
    expect(extractSeries).toHaveBeenCalledTimes(1);

    const seriesRows = await db.collection('series').find({ query_id: query._id }).toArray();
    expect(seriesRows).toHaveLength(4);
    expect(seriesRows.every(r => r.status === 'candidate')).toBe(true);

    const eventRows = await db.collection('events').find({ query_id: query._id }).toArray();
    expect(eventRows).toHaveLength(0);

    const queryRow = await db.collection('queries').findOne({ _id: query._id });
    expect(queryRow?.status).toBe('ready');
  });

  it('per-series expansion returns dated events linked via series_id', async () => {
    const query = await createQuery(db, userId, 'events in munich');
    const { discoverSeries } = discoveryDeps([{ title: 'Auer Dult', searchKeywords: 'Auer Dult Munich dates' }]);
    await runInitialQuery(db, query, { runQuery: vi.fn(), discoverSeries, applyCadence: false, userId });

    const [seriesRow] = await db.collection('series').find({ query_id: query._id }).toArray();

    // Existing per-series path, reused: searxngSearch + extractDates + dedupe.
    const searxngSearch = vi.fn().mockResolvedValue([{ title: 't', url: 'u', content: 'c' }]);
    const extractDates = vi.fn().mockResolvedValue({
      events: [
        { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
      ],
      cadence: null,
    });
    const runQuery = createSearchOrchestrator({ searxngSearch, extractDates });
    const { completeSeriesExpansion } = await import('./queriesRepo');
    const { reviewSeries } = await import('./seriesRepo');
    await reviewSeries(db, userId, query.queryId, [seriesRow._id.toString()]);

    const extracted = await runQuery(seriesRow.search_keywords);
    // 1 searxng call for the one expanded series.
    expect(searxngSearch).toHaveBeenCalledTimes(1);
    expect(searxngSearch).toHaveBeenCalledWith('Auer Dult Munich dates');

    const inserted = await completeSeriesExpansion(db, query._id, seriesRow._id, extracted.events);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ label: 'Frühjahrsdult', seriesId: seriesRow._id.toString() });
  });

  it('narrow query is the degenerate case: 1 series, same dated events as the single-stage path', async () => {
    const datedEvents = [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
      { label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'https://muenchen.de' },
    ];
    // Baseline: what the current single-stage path produces.
    const legacyRun = createSearchOrchestrator({
      searxngSearch: vi.fn().mockResolvedValue([{ title: 't', url: 'u', content: 'c' }]),
      extractDates: vi.fn().mockResolvedValue({ events: datedEvents, cadence: null }),
    });
    const baseline = await legacyRun('Auer Dult Munich');

    // Two-stage: discovery yields exactly 1 series, expansion matches.
    const query = await createQuery(db, userId, 'Auer Dult Munich');
    const { discoverSeries } = discoveryDeps([{ title: 'Auer Dult', searchKeywords: 'Auer Dult Munich' }]);
    await runInitialQuery(db, query, { runQuery: vi.fn(), discoverSeries, applyCadence: false, userId });

    const seriesRows = await db.collection('series').find({ query_id: query._id }).toArray();
    expect(seriesRows).toHaveLength(1);

    const perSeriesRun = createSearchOrchestrator({
      searxngSearch: vi.fn().mockResolvedValue([{ title: 't', url: 'u', content: 'c' }]),
      extractDates: vi.fn().mockResolvedValue({ events: datedEvents, cadence: null }),
    });
    const expanded = await perSeriesRun(seriesRows[0].search_keywords);
    expect(expanded.events).toEqual(baseline.events);
  });

  it('marks the query failed when discovery throws', async () => {
    const query = await createQuery(db, userId, 'events in munich');
    const discoverSeries = vi.fn().mockRejectedValue(new Error('opencode down'));

    await runInitialQuery(db, query, { runQuery: vi.fn(), discoverSeries, applyCadence: false, userId });

    const row = await db.collection('queries').findOne({ _id: query._id });
    expect(row?.status).toBe('failed');
    expect(await db.collection('series').countDocuments({ query_id: query._id })).toBe(0);
  });

  it('falls back to the legacy single-stage path when no discoverSeries is provided', async () => {
    const query = await createQuery(db, userId, 'Auer Dult Munich');
    const runQuery = vi.fn().mockResolvedValue({
      events: [{ label: 'L', startDate: '2026-01-01', endDate: '2026-01-01', sourceUrl: 'u' }],
      cadence: null,
    });

    await runInitialQuery(db, query, { runQuery, applyCadence: false });

    expect(runQuery).toHaveBeenCalledWith('Auer Dult Munich');
    expect(await db.collection('events').countDocuments({ query_id: query._id })).toBe(1);
  });
});
