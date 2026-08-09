import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { createClient } from '../db/client';
import { runMigrations } from '../db/migrate';
import { createQueryWithCandidates } from '../queries/queriesRepo';
import { approveEvents } from '../queries/approveEvents';
import { registerFeedRoutes } from './routes';
import Fastify from 'fastify';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'mongodb://localhost:27017/dontforget';

describe('feed routes', () => {
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

  it('serves ICS and RSS for a valid token, 404 for an unknown one', async () => {
    const { insertedId } = await db.collection('users').insertOne({ email: 'h@example.com' });
    const userId = insertedId.toString();
    const { queryId, candidates } = await createQueryWithCandidates(db, userId, 'Auer Dult Munich', [
      { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de' },
    ]);
    const { icsUrl } = (await approveEvents(db, userId, queryId, [candidates[0].id], 'http://x'))!;
    const token = icsUrl.split('/f/')[1].replace('.ics', '');

    const app = Fastify();
    registerFeedRoutes(app, { db });

    const icsResponse = await app.inject({ method: 'GET', url: `/f/${token}.ics` });
    expect(icsResponse.statusCode).toBe(200);
    expect(icsResponse.body).toContain('Frühjahrsdult');

    const rssResponse = await app.inject({ method: 'GET', url: `/f/${token}.rss` });
    expect(rssResponse.statusCode).toBe(200);
    expect(rssResponse.body).toContain('<rss');

    const missing = await app.inject({ method: 'GET', url: '/f/does-not-exist.ics' });
    expect(missing.statusCode).toBe(404);
  });
});