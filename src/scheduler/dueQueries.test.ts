import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../testSupport';
import { createQueryWithCandidates } from '../queries/queriesRepo';
import { findDueQueries } from './dueQueries';

describe('findDueQueries', () => {
  let client: MongoClient;
  let db: Db;
  let userId: string;

  beforeAll(async () => {
    ({ client, db } = await setupTestDb());
  });

  beforeEach(async () => {
    await cleanTestDb(db);
    const { insertedId } = await db.collection('users').insertOne({ email: 'h@example.com' });
    userId = insertedId.toString();
  });

  afterAll(async () => {
    await teardownTestDb(client);
  });

  async function backdateLastRunAt(queryId: string, daysAgo: number): Promise<void> {
    const lastRunAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    await db.collection('queries').updateOne({ _id: new ObjectId(queryId) }, { $set: { last_run_at: lastRunAt } });
  }

  it('returns a weekly query whose last run was more than a week ago', async () => {
    const { queryId } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [], 'weekly');
    await backdateLastRunAt(queryId, 8);

    const due = await findDueQueries(db, new Date());

    expect(due.map(q => q._id.toString())).toEqual([queryId]);
    expect(due[0]).toEqual({
      _id: new ObjectId(queryId),
      user_id: userId,
      query_text: 'Auer Dult Munich',
      recurrence_interval: 'weekly',
    });
  });

  it('does not return a weekly query whose last run was recent', async () => {
    const { queryId } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [], 'weekly');
    await backdateLastRunAt(queryId, 2);

    const due = await findDueQueries(db, new Date());

    expect(due).toEqual([]);
  });

  it('respects a monthly query’s longer interval', async () => {
    const { queryId: dueOne } = await createQueryWithCandidates(db, userId, 'Due monthly', [], 'monthly');
    await backdateLastRunAt(dueOne, 40);
    const { queryId: notDueOne } = await createQueryWithCandidates(db, userId, 'Not due monthly', [], 'monthly');
    await backdateLastRunAt(notDueOne, 10);

    const due = await findDueQueries(db, new Date());

    expect(due.map(q => q._id.toString())).toEqual([dueOne]);
  });

  it('returns due queries regardless of which user owns them', async () => {
    const { insertedId } = await db.collection('users').insertOne({ email: 'i@example.com' });
    const otherUserId = insertedId.toString();
    const { queryId: mine } = await createQueryWithCandidates(db, userId, 'Mine', [], 'weekly');
    const { queryId: theirs } = await createQueryWithCandidates(db, otherUserId, 'Theirs', [], 'weekly');
    await backdateLastRunAt(mine, 8);
    await backdateLastRunAt(theirs, 8);

    const due = await findDueQueries(db, new Date());

    expect(due.map(q => q._id.toString()).sort()).toEqual([mine, theirs].sort());
  });
});
