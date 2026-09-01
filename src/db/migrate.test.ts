import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { createClient } from './client';
import { runMigrations } from './migrate';
import { TEST_DB_URL, teardownTestDb } from '../testSupport';

describe('runMigrations', () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    client = await createClient(TEST_DB_URL);
    db = client.db();
  });

  afterAll(async () => {
    await teardownTestDb(client);
  });

  it('applies pending migrations and is idempotent', async () => {
    await db.dropDatabase();

    const firstRun = await runMigrations(db);
    expect(firstRun).toEqual([
      '001_init.ts',
      '002_queries_dashboard.ts',
      '003_events_dedup_index.ts',
      '004_models_metrics.ts',
      '005_swap_dead_models.ts',
      '006_swap_default_model.ts',
    ]);

    const collections = await db.listCollections().toArray();
    expect(collections.map(c => c.name)).toEqual(
      expect.arrayContaining([
        'users',
        'magic_links',
        'sessions',
        'queries',
        'events',
        'feed_tokens',
        'models',
        'model_metrics',
        'search_metrics',
      ])
    );

    const feedIndexes = await db.collection('feed_tokens').indexes();
    expect(feedIndexes.map(i => i.name)).toEqual(expect.arrayContaining(['user_id_1', 'token_1']));

    const queriesIndexes = await db.collection('queries').indexes();
    expect(queriesIndexes.map(i => i.name)).toEqual(
      expect.arrayContaining(['user_id_1_created_at_-1'])
    );

    const eventsIndexes = await db.collection('events').indexes();
    expect(eventsIndexes.map(i => i.name)).toEqual(
      expect.arrayContaining(['query_id_1', 'query_id_1_status_1', 'query_id_1_status_1_label_1_start_date_1_end_date_1'])
    );

    const secondRun = await runMigrations(db);
    expect(secondRun).toEqual([]);
  });
});