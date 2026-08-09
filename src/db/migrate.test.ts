import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { createClient } from './client';
import { runMigrations } from './migrate';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  'mongodb://localhost:27017/dontforget';

describe('runMigrations', () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    client = await createClient(TEST_DB_URL);
    db = client.db();
  });

  afterAll(async () => {
    await client.close();
  });

  it('applies pending migrations and is idempotent', async () => {
    await db.dropDatabase();

    const firstRun = await runMigrations(db);
    expect(firstRun).toEqual(['001_init.ts']);

    const collections = await db.listCollections().toArray();
    expect(collections.map(c => c.name)).toEqual(
      expect.arrayContaining(['users', 'magic_links', 'sessions', 'queries', 'events', 'feed_tokens'])
    );

    const indexes = await db.collection('feed_tokens').indexes();
    expect(indexes.map(i => i.name)).toEqual(expect.arrayContaining(['user_id_1', 'token_1']));

    const secondRun = await runMigrations(db);
    expect(secondRun).toEqual([]);
  });
});