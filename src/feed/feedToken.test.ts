import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { createClient } from '../db/client';
import { runMigrations } from '../db/migrate';
import { getOrCreateFeedToken } from './feedToken';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'mongodb://localhost:27017/dontforget';

describe('getOrCreateFeedToken', () => {
  let client: MongoClient;
  let db: Db;
  let userId: string;

  beforeAll(async () => {
    client = await createClient(TEST_DB_URL);
    db = client.db();
    await runMigrations(db);
  });

  beforeEach(async () => {
    for (const name of ['users', 'magic_links', 'sessions', 'queries', 'events', 'feed_tokens']) {
      await db.collection(name).deleteMany({});
    }
    const { insertedId } = await db.collection('users').insertOne({ email: 'e@example.com' });
    userId = insertedId.toString();
  });

  afterAll(async () => {
    await client.close();
  });

  it('creates a token once and reuses it on subsequent calls', async () => {
    const first = await getOrCreateFeedToken(db, userId);
    const second = await getOrCreateFeedToken(db, userId);
    expect(first).toBe(second);

    const count = await db.collection('feed_tokens').countDocuments({ user_id: userId });
    expect(count).toBe(1);
  });
});