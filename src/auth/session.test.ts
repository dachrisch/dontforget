import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { createClient } from '../db/client';
import { runMigrations } from '../db/migrate';
import { SessionService } from './session';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'mongodb://localhost:27017/dontforget';

describe('SessionService', () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    client = await createClient(TEST_DB_URL);
    db = client.db();
    await runMigrations(db);
  });

  beforeEach(async () => {
    for (const name of ['users', 'magic_links', 'sessions', 'queries', 'events', 'feed_tokens']) {
      await db.collection(name).deleteMany({});
    }
  });

  afterAll(async () => {
    await client.close();
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