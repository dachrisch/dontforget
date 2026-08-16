import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../testSupport';
import { createQueryWithCandidates } from '../queries/queriesRepo';
import { approveEvents } from '../queries/approveEvents';
import { CapturingEmailSender } from '../email/EmailSender';
import { runScheduledQuery, type ScheduledRunDeps } from './scheduledRun';
import type { DueQuery } from './dueQueries';

describe('runScheduledQuery', () => {
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

  it('auto-approves new events for a trusted query and emails an FYI', async () => {
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://a.example' },
    ]);
    await approveEvents(db, userId, queryId, [candidates[0].id], 'http://localhost:3000');

    const emailSender = new CapturingEmailSender();
    const deps: ScheduledRunDeps = {
      runQuery: vi.fn().mockResolvedValue({
        events: [
          { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://a.example' },
          { label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'https://a.example' },
        ],
        cadence: null,
      }),
      emailSender,
      publicBaseUrl: 'http://localhost:3000',
    };

    await runScheduledQuery(db, dueQueryFrom(queryId, 'Auer Dult Munich'), deps);

    const events = await db.collection('events').find({ query_id: new ObjectId(queryId) }).toArray();
    expect(events).toHaveLength(2); // the original approved one + the one genuinely new one
    const jakobidult = events.find(e => e.label === 'Jakobidult');
    expect(jakobidult?.status).toBe('approved');

    expect(emailSender.sent).toHaveLength(1);
    expect(emailSender.sent[0].to).toBe(userEmail);
    expect(emailSender.sent[0].subject).toMatch(/added to your feed.*Auer Dult Munich/);

    const row = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });
    expect(row?.last_run_at).toBeInstanceOf(Date);
  });

  it('lands new events as candidates for a never-approved query and emails a review prompt', async () => {
    const { queryId } = await createQueryWithCandidates(db, userId, 'Oktoberfest', []);

    const emailSender = new CapturingEmailSender();
    const deps: ScheduledRunDeps = {
      runQuery: vi.fn().mockResolvedValue({
        events: [
          { label: 'Oktoberfest', startDate: '2026-09-19', endDate: '2026-10-04', sourceUrl: 'https://a.example' },
        ],
        cadence: null,
      }),
      emailSender,
      publicBaseUrl: 'http://localhost:3000',
    };

    await runScheduledQuery(db, dueQueryFrom(queryId, 'Oktoberfest'), deps);

    const events = await db.collection('events').find({ query_id: new ObjectId(queryId) }).toArray();
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('candidate');

    expect(emailSender.sent).toHaveLength(1);
    expect(emailSender.sent[0].subject).toMatch(/Oktoberfest.*go review/);
  });

  it('does not re-insert an event that already exists, and sends no email when nothing is new', async () => {
    const { queryId } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://a.example' },
    ]);
    // Backdate so a real update is distinguishable from the value
    // createQueryWithCandidates already stamped at creation.
    const staleLastRunAt = new Date('2020-01-01T00:00:00Z');
    await db.collection('queries').updateOne({ _id: new ObjectId(queryId) }, { $set: { last_run_at: staleLastRunAt } });

    const emailSender = new CapturingEmailSender();
    const deps: ScheduledRunDeps = {
      runQuery: vi.fn().mockResolvedValue({
        events: [
          { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://a-different-page.example' },
        ],
        cadence: null,
      }),
      emailSender,
      publicBaseUrl: 'http://localhost:3000',
    };

    await runScheduledQuery(db, dueQueryFrom(queryId, 'Auer Dult Munich'), deps);

    const events = await db.collection('events').find({ query_id: new ObjectId(queryId) }).toArray();
    expect(events).toHaveLength(1);
    expect(emailSender.sent).toHaveLength(0);

    // last_run_at still advances on a "found nothing new" run — only an
    // orchestrator error (tested below) leaves it untouched.
    const row = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });
    expect(row?.last_run_at).not.toEqual(staleLastRunAt);
  });

  it('does not update last_run_at when the orchestrator throws', async () => {
    const { queryId } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', []);
    const before = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });

    const deps: ScheduledRunDeps = {
      runQuery: vi.fn().mockRejectedValue(new Error('searxng is down')),
      emailSender: new CapturingEmailSender(),
      publicBaseUrl: 'http://localhost:3000',
    };

    await expect(runScheduledQuery(db, dueQueryFrom(queryId, 'Auer Dult Munich'), deps)).rejects.toThrow(
      'searxng is down'
    );

    const after = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });
    expect(after?.last_run_at).toEqual(before?.last_run_at);
  });

  it('still writes events and updates last_run_at when the email fails to send', async () => {
    const { queryId } = await createQueryWithCandidates(db, userId, 'Oktoberfest', []);
    // Backdate so a real update is distinguishable from the value
    // createQueryWithCandidates already stamped at creation.
    const staleLastRunAt = new Date('2020-01-01T00:00:00Z');
    await db.collection('queries').updateOne({ _id: new ObjectId(queryId) }, { $set: { last_run_at: staleLastRunAt } });

    const deps: ScheduledRunDeps = {
      runQuery: vi.fn().mockResolvedValue({
        events: [
          { label: 'Oktoberfest', startDate: '2026-09-19', endDate: '2026-10-04', sourceUrl: 'https://a.example' },
        ],
        cadence: null,
      }),
      emailSender: { send: vi.fn().mockRejectedValue(new Error('smtp down')) },
      publicBaseUrl: 'http://localhost:3000',
    };

    await runScheduledQuery(db, dueQueryFrom(queryId, 'Oktoberfest'), deps);

    const events = await db.collection('events').find({ query_id: new ObjectId(queryId) }).toArray();
    expect(events).toHaveLength(1);
    const row = await db.collection('queries').findOne({ _id: new ObjectId(queryId) });
    expect(row?.last_run_at).not.toEqual(staleLastRunAt);
  });
});
