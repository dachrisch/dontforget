import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../testSupport';
import { getOrCreateFeedToken, rotateFeedToken } from './feedToken';

describe('getOrCreateFeedToken', () => {
  let client: MongoClient;
  let db: Db;
  let userId: string;

  beforeAll(async () => {
    ({ client, db } = await setupTestDb());
  });

  beforeEach(async () => {
    await cleanTestDb(db);
    const { insertedId } = await db.collection('users').insertOne({ email: 'e@example.com' });
    userId = insertedId.toString();
  });

  afterAll(async () => {
    await teardownTestDb(client);
  });

  it('creates a token once and reuses it on subsequent calls', async () => {
    const first = await getOrCreateFeedToken(db, userId);
    const second = await getOrCreateFeedToken(db, userId);
    expect(first).toBe(second);

    const count = await db.collection('feed_tokens').countDocuments({ user_id: userId });
    expect(count).toBe(1);
  });
});

describe('rotateFeedToken', () => {
  let client: MongoClient;
  let db: Db;
  let userId: string;

  beforeAll(async () => {
    ({ client, db } = await setupTestDb());
  });

  beforeEach(async () => {
    await cleanTestDb(db);
    const { insertedId } = await db.collection('users').insertOne({ email: 'e@example.com' });
    userId = insertedId.toString();
  });

  afterAll(async () => {
    await teardownTestDb(client);
  });

  it('replaces an existing token and invalidates the old one', async () => {
    const original = await getOrCreateFeedToken(db, userId);
    const rotated = await rotateFeedToken(db, userId);

    expect(rotated).not.toBe(original);
    const count = await db.collection('feed_tokens').countDocuments({ user_id: userId });
    expect(count).toBe(1);
    const stale = await db.collection('feed_tokens').findOne({ token: original });
    expect(stale).toBeNull();
  });

  it('creates a token if none existed yet', async () => {
    const rotated = await rotateFeedToken(db, userId);
    const row = await db.collection('feed_tokens').findOne({ user_id: userId });
    expect(row?.token).toBe(rotated);
  });
});