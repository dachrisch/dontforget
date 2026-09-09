import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../testSupport';
import { createQuery } from '../queries/queriesRepo';
import { insertDiscoveredSeries, reviewSeries } from '../queries/seriesRepo';
import { CapturingEmailSender } from '../email/EmailSender';
import { runScheduledQuery, type ScheduledRunDeps } from './scheduledRun';
import type { DueQuery } from './dueQueries';

// Scheduler series semantics (issue #143): approved series pick up new
// dates without re-approval; dismissed/candidate series are never expanded
// or re-created.
describe('runScheduledQuery with series', () => {
  let client: MongoClient;
  let db: Db;
  let userId: string;
  let userEmail: string;

  beforeAll(async () => {
    ({ client, db } = await setupTestDb());
  });

  beforeEach(async () => {
    await cleanTestDb(db);
    userEmail = 'j@example.com';
    const { insertedId } = await db.collection('users').insertOne({ email: userEmail });
    userId = insertedId.toString();
  });

  afterAll(async () => {
    await teardownTestDb(client);
  });

  function dueQueryFrom(queryId: string, queryText: string): DueQuery {
    return { _id: new ObjectId(queryId), user_id: userId, query_text: queryText, recurrence_interval: 'weekly' };
  }

  async function setupQueryWithSeries(queryText: string) {
    const query = await createQuery(db, userId, queryText);
    const inserted = await insertDiscoveredSeries(db, query._id, userId, [
      { title: 'Oktoberfest', appliesTo: 'Oktoberfest, Munich', description: 'd', searchKeywords: 'Oktoberfest Munich dates', sourceUrls: ['https://a.example'] },
      { title: 'Auer Dult', appliesTo: 'Auer Dult, Munich', description: 'd', searchKeywords: 'Auer Dult Munich dates', sourceUrls: ['https://b.example'] },
    ]);
    return { query, inserted };
  }

  it('expands approved series without re-approval and emails an FYI', async () => {
    const { query, inserted } = await setupQueryWithSeries('events in munich');
    await reviewSeries(db, userId, query.queryId, [inserted[0].id], [inserted[1].id]);

    const emailSender = new CapturingEmailSender();
    const runQuery = vi.fn().mockImplementation(async (keywords: string) => {
      if (keywords === 'Oktoberfest Munich dates') {
        return {
          events: [{ label: 'Oktoberfest', startDate: '2026-09-19', endDate: '2026-10-04', sourceUrl: 'https://a.example' }],
          cadence: null,
        };
      }
      throw new Error(`unexpected expansion for dismissed series: ${keywords}`);
    });
    const deps: ScheduledRunDeps = { runQuery, emailSender, publicBaseUrl: 'http://localhost:3000' };

    await runScheduledQuery(db, dueQueryFrom(query.queryId, 'events in munich'), deps);

    // Only the approved series was expanded (1 searxng call, not 2).
    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(runQuery).toHaveBeenCalledWith('Oktoberfest Munich dates');

    const events = await db.collection('events').find({ query_id: query._id }).toArray();
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('approved');
    expect(events[0].series_id.toString()).toBe(inserted[0].id);

    expect(emailSender.sent).toHaveLength(1);
    expect(emailSender.sent[0].to).toBe(userEmail);
    expect(emailSender.sent[0].subject).toMatch(/added to your feed/);
  });

  it('picks up new dates on re-run for an approved series without re-approval', async () => {
    const { query, inserted } = await setupQueryWithSeries('events in munich');
    await reviewSeries(db, userId, query.queryId, [inserted[0].id]);

    const emailSender = new CapturingEmailSender();
    const first: ScheduledRunDeps = {
      runQuery: vi.fn().mockResolvedValue({
        events: [{ label: 'Oktoberfest', startDate: '2026-09-19', endDate: '2026-10-04', sourceUrl: 'https://a.example' }],
        cadence: null,
      }),
      emailSender,
      publicBaseUrl: 'http://localhost:3000',
    };
    await runScheduledQuery(db, dueQueryFrom(query.queryId, 'events in munich'), first);
    expect((await db.collection('events').find({ query_id: query._id }).toArray())).toHaveLength(1);

    const second: ScheduledRunDeps = {
      runQuery: vi.fn().mockResolvedValue({
        events: [
          { label: 'Oktoberfest', startDate: '2026-09-19', endDate: '2026-10-04', sourceUrl: 'https://a.example' },
          { label: 'Oktoberfest next', startDate: '2027-09-18', endDate: '2027-10-03', sourceUrl: 'https://a.example' },
        ],
        cadence: null,
      }),
      emailSender,
      publicBaseUrl: 'http://localhost:3000',
    };
    await runScheduledQuery(db, dueQueryFrom(query.queryId, 'events in munich'), second);

    const events = await db.collection('events').find({ query_id: query._id }).toArray();
    expect(events).toHaveLength(2);
    expect(events.every(e => e.status === 'approved')).toBe(true);
  });

  it('never expands dismissed or candidate series and advances last_run_at', async () => {
    const { query, inserted } = await setupQueryWithSeries('events in munich');
    await reviewSeries(db, userId, query.queryId, [], [inserted[0].id, inserted[1].id]);
    const stale = new Date('2020-01-01T00:00:00Z');
    await db.collection('queries').updateOne({ _id: query._id }, { $set: { last_run_at: stale } });

    const deps: ScheduledRunDeps = {
      runQuery: vi.fn(),
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
    };
    await runScheduledQuery(db, dueQueryFrom(query.queryId, 'events in munich'), deps);

    expect(deps.runQuery).not.toHaveBeenCalled();
    expect(await db.collection('events').countDocuments({ query_id: query._id })).toBe(0);
    const row = await db.collection('queries').findOne({ _id: query._id });
    expect(row?.last_run_at).not.toEqual(stale);
    expect(row?.status).toBe('ready');
  });

  it('does not re-create a dismissed series title on refresh-style re-discovery', async () => {
    const { query, inserted } = await setupQueryWithSeries('events in munich');
    await reviewSeries(db, userId, query.queryId, [], [inserted[0].id]);

    const rediscovered = await insertDiscoveredSeries(db, query._id, userId, [
      { title: 'oktoberfest', appliesTo: 'Oktoberfest, Munich', description: 'd', searchKeywords: 'Oktoberfest Munich dates', sourceUrls: ['https://a.example'] },
      { title: 'New Series', appliesTo: 'New Series, Munich', description: 'd', searchKeywords: 'New Series Munich', sourceUrls: ['https://c.example'] },
    ]);

    expect(rediscovered.map(s => s.title)).toEqual(['New Series']);
  });

  it('expands via the series-scoped path and names the subscribed series in the email', async () => {
    const { query, inserted } = await setupQueryWithSeries('events in munich');
    await reviewSeries(db, userId, query.queryId, [inserted[1].id], [inserted[0].id]);

    const emailSender = new CapturingEmailSender();
    const runSeriesExpansion = vi.fn().mockResolvedValue({
      events: [{ label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'https://b.example' }],
      cadence: null,
    });
    const runQuery = vi.fn();
    const deps: ScheduledRunDeps = { runQuery, runSeriesExpansion, emailSender, publicBaseUrl: 'http://localhost:3000' };

    await runScheduledQuery(db, dueQueryFrom(query.queryId, 'events in munich'), deps);

    expect(runSeriesExpansion).toHaveBeenCalledTimes(1);
    expect(runSeriesExpansion).toHaveBeenCalledWith(
      expect.objectContaining({ appliesTo: 'Auer Dult, Munich' })
    );
    expect(runQuery).not.toHaveBeenCalled();
    expect(emailSender.sent).toHaveLength(1);
    expect(emailSender.sent[0].subject).toMatch(/Auer Dult, Munich/);
  });
});
