import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../testSupport';
import { SessionService } from './session';

describe('SessionService', () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    ({ client, db } = await setupTestDb());
  });

  beforeEach(async () => {
    await cleanTestDb(db);
  });

  afterAll(async () => {
    await teardownTestDb(client);
  });

  it('creates a session that resolves back to the same user', async () => {
    const { insertedId } = await db.collection('users').insertOne({ email: 'c@example.com' });
    const service = new SessionService(db);

    const sessionId = await service.createSession(insertedId.toString());
    expect(await service.getUserId(sessionId)).toBe(insertedId.toString());
  });

  it('returns null for an unknown session', async () => {
    const service = new SessionService(db);
    expect(await service.getUserId('nope')).toBeNull();
  });
});